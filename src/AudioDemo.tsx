// 按论文数据集分区试听：切换只等待小型指标文件，语谱图独立加载与重试。
// 默认场景提前准备，其他试听图片与原始 WAV 分阶段预取，缓存复访数据。
// 保留原生播放器、独立进度、互斥播放、语谱图跳转和 Easy 内部分析模式。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import InternalVisualizations from "./InternalVisualizations";
import { optimizedImageUrl } from "./imageAssets";
import { mediaCache } from "./mediaCache";

type SceneViewMode = "audio" | "internals";

const sceneOptions = [
  { id: "easy-01", label: "Easy 01" },
  { id: "easy-02", label: "Easy 02" },
  { id: "easy-03", label: "Easy 03" },
  { id: "hard-01", label: "Hard 01" },
  { id: "hard-02", label: "Hard 02" },
  { id: "hard-03", label: "Hard 03" },
] as const;

type SceneId = (typeof sceneOptions)[number]["id"];
type MetricName = "PESQ" | "ESTOI" | "SISDR" | "OVRL" | "SIG" | "BAK" | "P808_MOS";
type MetricRow = Record<MetricName, number>;

interface Experiment {
  id: string;
  audio: string;
  spectrogram: string;
}

interface Scene {
  id: string;
  split: "Easy" | "Hard";
  sampleId: string;
  mixtureSpeakerCount: number;
  mixtureAudio: string;
  mixtureSpectrogram: string;
  enhancedMetricsFile: string;
  target: {
    azimuthDeg: number;
    elevationDeg: number;
    distanceM: number;
    cleanAudio: string;
    cleanSpectrogram: string;
  };
  acousticConditions: {
    noise: { azimuthDeg: number; elevationDeg: number; distanceM: number };
    room: {
      shape: string;
      dimensionsM: { x: number; y: number; z: number };
    };
  };
  experiments: Experiment[];
}

interface Track {
  key: string;
  label: string;
  kind: "unprocessed" | "clean" | "enhanced";
  audio: string;
  spectrogram: string;
  metrics?: MetricRow;
}

interface SceneDetail {
  sceneId: SceneId;
  scene?: Scene;
  tracks?: Track[];
  error?: string;
}

interface TrackCardProps {
  track: Track;
  showNonIntrusive: boolean;
  savedPosition: (key: string) => number;
  rememberPosition: (key: string, seconds: number) => void;
  onPlay: (audio: HTMLAudioElement) => void;
  onPause: (audio: HTMLAudioElement) => void;
}

interface SceneGroupProps {
  split: Scene["split"];
  scenes: Partial<Record<SceneId, Scene>>;
  sceneErrors: Partial<Record<SceneId, string>>;
  savedPosition: (key: string) => number;
  rememberPosition: (key: string, seconds: number) => void;
  onPlay: (audio: HTMLAudioElement) => void;
  onPause: (audio: HTMLAudioElement) => void;
  onSceneChange: () => void;
  onReloadScene: (id: SceneId) => void;
}

const metricNames: MetricName[] = ["PESQ", "ESTOI", "SISDR", "OVRL", "SIG", "BAK", "P808_MOS"];
const metricsCache = new Map<string, Record<string, MetricRow>>();
const metricsRequests = new Map<string, Promise<Record<string, MetricRow>>>();
const detailCache = new Map<SceneId, SceneDetail>();
const sceneCache = new Map<SceneId, Scene>();
const sceneRequests = new Map<SceneId, Promise<Scene>>();

/** 依据 Vite 基路径拼接可在本地和子路径部署下使用的资产地址。 */
function sceneAssetUrl(sceneId: SceneId, relativePath: string): string {
  return `${import.meta.env.BASE_URL}assets/scenes/${sceneId}/${relativePath}`;
}

/** 校验页面必需的场景字段，避免错误清单导致空白详情。 */
function parseScene(raw: unknown, expectedId: SceneId): Scene {
  const scene = raw as Scene;
  const room = scene?.acousticConditions?.room;
  const noise = scene?.acousticConditions?.noise;
  const target = scene?.target;
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const path = (value: unknown) => typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("..");

  if (
    scene?.id !== expectedId || scene.split?.toLowerCase() !== expectedId.split("-")[0] ||
    !scene.sampleId || !finite(scene.mixtureSpeakerCount) ||
    !path(scene.mixtureAudio) || !path(scene.mixtureSpectrogram) || !path(scene.enhancedMetricsFile) ||
    !path(target?.cleanAudio) || !path(target?.cleanSpectrogram) ||
    !finite(target?.azimuthDeg) || !finite(target?.elevationDeg) || !finite(target?.distanceM) ||
    !finite(noise?.azimuthDeg) || !finite(noise?.elevationDeg) || !finite(noise?.distanceM) ||
    !room?.shape ||
    !finite(room.dimensionsM?.x) || !finite(room.dimensionsM?.y) || !finite(room.dimensionsM?.z) ||
    !Array.isArray(scene.experiments) ||
    scene.experiments.some((entry) => !entry.id || !path(entry.audio) || !path(entry.spectrogram))
  ) {
    throw new Error("Scene metadata is incomplete.");
  }
  return scene;
}

/** 共享场景清单请求并限制等待时间，不让无关场景阻塞默认试听。 */
function loadScene(id: SceneId, retry = false): Promise<Scene> {
  if (retry) { sceneCache.delete(id); detailCache.delete(id); }
  const cached = sceneCache.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = sceneRequests.get(id);
  if (pending) return pending;
  const request = fetch(sceneAssetUrl(id, "scene.json"), { signal: AbortSignal.timeout(15000), cache: retry ? "reload" : "default" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Scene metadata could not be loaded (${response.status}).`);
      const scene = parseScene(await response.json(), id);
      sceneCache.set(id, scene);
      return scene;
    })
    .finally(() => sceneRequests.delete(id));
  sceneRequests.set(id, request);
  return request;
}

/** 将静态 CSV 严格解析为按实验 ID 索引的有限数值指标。 */
function parseMetricsCsv(csv: string): Record<string, MetricRow> {
  const lines = csv.trim().replace(/^\uFEFF/, "").split(/\r?\n/);
  const columns = lines[0]?.split(",").map((column) => column.trim()) ?? [];
  if (!columns.includes("ID") || metricNames.some((name) => !columns.includes(name))) {
    throw new Error("The metrics file is missing required columns.");
  }

  const rows: Record<string, MetricRow> = {};
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(",").map((cell) => cell.trim());
    const id = cells[columns.indexOf("ID")];
    if (!id || rows[id] || cells.length !== columns.length) {
      throw new Error("The metrics file has an invalid or repeated experiment ID.");
    }
    const metrics = {} as MetricRow;
    for (const name of metricNames) {
      const rawValue = cells[columns.indexOf(name)];
      const value = Number(rawValue);
      if (!rawValue || !Number.isFinite(value)) {
        throw new Error(`The ${name} value for ${id} is unavailable.`);
      }
      metrics[name] = value;
    }
    rows[id] = metrics;
  }
  return rows;
}

/** 复用成功指标和正在进行的请求，失败后允许用户明确重试。 */
function loadMetrics(scene: Scene): Promise<Record<string, MetricRow>> {
  const url = sceneAssetUrl(scene.id as SceneId, scene.enhancedMetricsFile);
  const cached = metricsCache.get(url);
  if (cached) return Promise.resolve(cached);
  const pending = metricsRequests.get(url);
  if (pending) return pending;
  const request = fetch(url, { signal: AbortSignal.timeout(15000) })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Quality metrics could not be loaded (${response.status}).`);
      const rows = parseMetricsCsv(await response.text());
      metricsCache.set(url, rows);
      return rows;
    })
    .finally(() => metricsRequests.delete(url));
  metricsRequests.set(url, request);
  return request;
}

/** 只列出页面展示的试听资源，排除 ID 5、Hard SC 与内部分析图。 */
function sceneMedia(scene: Scene): { images: string[]; audio: string[] } {
  const ids = scene.split === "Easy" ? ["ID3", "ID4", "ID8", "ID9"] : ["TF", "SP"];
  const entries = ids.flatMap((id) => scene.experiments.filter((experiment) => experiment.id === id));
  const images = [scene.mixtureSpectrogram, scene.target.cleanSpectrogram, ...entries.map((entry) => entry.spectrogram)]
    .map((path) => optimizedImageUrl(sceneAssetUrl(scene.id as SceneId, path)));
  const audio = [scene.mixtureAudio, scene.target.cleanAudio, ...entries.map((entry) => entry.audio)]
    .map((path) => sceneAssetUrl(scene.id as SceneId, path));
  return { images, audio };
}

/** 按论文试听顺序将场景清单映射为当前应展示的音轨。 */
function buildTracks(scene: Scene, metrics: Record<string, MetricRow>): Track[] {
  const sceneId = scene.id as SceneId;
  const tracks: Track[] = [
    {
      key: `${sceneId}:unprocessed`,
      label: "Unprocessed",
      kind: "unprocessed",
      audio: sceneAssetUrl(sceneId, scene.mixtureAudio),
      spectrogram: optimizedImageUrl(sceneAssetUrl(sceneId, scene.mixtureSpectrogram)),
    },
    {
      key: `${sceneId}:clean`,
      label: "Clean",
      kind: "clean",
      audio: sceneAssetUrl(sceneId, scene.target.cleanAudio),
      spectrogram: optimizedImageUrl(sceneAssetUrl(sceneId, scene.target.cleanSpectrogram)),
    },
  ];

  const requested = scene.split === "Easy"
    ? [
        { id: "ID3", label: "JNF-SSF (ID 3)" },
        { id: "ID4", label: "JNF-Concat (ID 4)" },
        { id: "ID8", label: "JNF-SoundCompass-Fusion (ID 8)" },
        { id: "ID9", label: "JNF-CORE (ID 9)" },
      ]
    : [
        { id: "TF", label: "TF-GridNet-CORE" },
        { id: "SP", label: "SpatialNet-CORE" },
      ];

  for (const item of requested) {
    const experiment = scene.experiments.find((entry) => entry.id === item.id);
    const row = metrics[item.id];
    if (!experiment || !row) {
      throw new Error(`Required audio or metrics for ${item.label} are unavailable.`);
    }
    tracks.push({
      key: `${sceneId}:${item.id}`,
      label: item.label,
      kind: "enhanced",
      audio: sceneAssetUrl(sceneId, experiment.audio),
      spectrogram: optimizedImageUrl(sceneAssetUrl(sceneId, experiment.spectrogram)),
      metrics: row,
    });
  }
  return tracks;
}

/** 单图接近视口后复用调度缓存，失败仅影响本图并保留固定占位。 */
function AudioSpectrogramImage({ url, label, onReady }: { url: string; label: string; onReady: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [requested, setRequested] = useState(false);
  const [imageUrl, setImageUrl] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (requested || !surfaceRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setRequested(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(surfaceRef.current);
    return () => observer.disconnect();
  }, [requested]);

  useEffect(() => {
    if (!requested) return;
    let live = true;
    setFailed(false);
    const request = mediaCache.acquire(url, "image", attempt > 0);
    request.promise.then((value) => { if (live) setImageUrl(value); }).catch((error: unknown) => {
      if (live && !(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
    });
    return () => { live = false; request.release(); };
  }, [url, requested, attempt]);

  /** 解码只控制单图淡入，不再阻塞场景切换。 */
  async function imageLoaded(image: HTMLImageElement) {
    try {
      await image.decode();
      if (image.isConnected) { setLoaded(true); onReady(); }
    } catch { if (image.isConnected) setFailed(true); }
  }

  /** 清理失败缓存并重新请求这一张语谱图。 */
  function retry() {
    mediaCache.invalidate(url);
    setLoaded(false);
    setImageUrl(undefined);
    setFailed(false);
    setAttempt((current) => current + 1);
  }

  return (
    <div ref={surfaceRef} className="audio-image-layer" data-image-state={failed ? "error" : loaded ? "ready" : "loading"} aria-busy={!loaded && !failed}>
      {imageUrl && !failed && <img src={imageUrl} alt="" width={1200} height={493} className={`audio-spectrogram-image${loaded ? " audio-spectrogram-image--loaded" : ""}`} draggable={false} onLoad={(event) => { void imageLoaded(event.currentTarget); }} onError={() => setFailed(true)} />}
      {!loaded && <span className={`audio-image-status${failed ? " audio-image-status--error" : ""}`} role={failed ? "alert" : "status"}>
        {failed ? <><span>Spectrogram could not be loaded.</span><button type="button" className="metric-toggle" aria-label={`Retry ${label} spectrogram`} onClick={(event) => { event.stopPropagation(); retry(); }}>Retry image</button></> : "Loading spectrogram…"}
      </span>}
    </div>
  );
}

/** 展示说话人数量和目标位置。 */
function AcousticConditions({ scene }: { scene: Scene }) {
  const { target } = scene;

  return (
    <dl className="acoustic-grid" aria-label="Acoustic conditions">
      <div><dt>Number of Speakers</dt><dd>{scene.mixtureSpeakerCount}</dd></div>
      <div>
        <dt>Target Position</dt>
        <dd>
          <span className="position-coordinate">Azimuth {target.azimuthDeg.toFixed(1)}°</span>{" · "}
          <span className="position-coordinate">Elevation {target.elevationDeg.toFixed(1)}°</span>{" · "}
          <span className="position-coordinate">Distance {target.distanceM.toFixed(2)} m</span>
        </dd>
      </div>
    </dl>
  );
}

/** 绘制当前音轨的音频控件、可跳转语谱图与可用指标。 */
function TrackCard({ track, showNonIntrusive, savedPosition, rememberPosition, onPlay, onPause }: TrackCardProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeekRef = useRef<number | null>(savedPosition(track.key));
  const [position, setPosition] = useState(() => savedPosition(track.key));
  const [audioError, setAudioError] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [audioUrl] = useState(() => mediaCache.cachedUrl(track.audio) ?? track.audio);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (audio) {
        audio.pause();
        mediaCache.setBuffering(track.key, false);
        if (pendingSeekRef.current === null && audio.readyState >= HTMLMediaElement.HAVE_METADATA) rememberPosition(track.key, audio.currentTime);
        onPause(audio);
      }
    };
  }, [track.key]);

  /** 同时更新本卡游标和跨场景切换保存的播放位置。 */
  function updatePosition(seconds: number) {
    if (!Number.isFinite(seconds)) return;
    setPosition(seconds);
    rememberPosition(track.key, seconds);
  }

  /** 将鼠标或键盘指定的时间应用到对应音频。 */
  function seekTo(seconds: number) {
    const audio = audioRef.current;
    const availableDuration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 10;
    const nextPosition = Math.max(0, Math.min(availableDuration, seconds));
    pendingSeekRef.current = nextPosition;
    if (audio && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      audio.currentTime = nextPosition;
      pendingSeekRef.current = null;
    }
    updatePosition(nextPosition);
  }

  /** 在元数据可用时恢复已保存或提前指定的播放位置。 */
  function loadMetadata() {
    setAudioError(false);
    seekTo(pendingSeekRef.current ?? savedPosition(track.key));
  }

  /** 同步暂停状态并保存音轨的实际位置。 */
  function pausePlayback(audio: HTMLAudioElement) {
    if (pendingSeekRef.current === null) updatePosition(audio.currentTime);
    mediaCache.setBuffering(track.key, false);
    onPause(audio);
  }

  return (
    <article className={`audio-track-card${track.label.includes("CORE") ? " audio-track-card--core" : ""}`}>
      <div className="audio-track-heading">
        <h5>{track.label}</h5>
      </div>

      <div className="spectrogram" aria-label={`${track.label} spectrogram, 0 to 10 seconds and 0 to 8 kilohertz`}>
        <span className="frequency-label" aria-hidden="true">Frequency (kHz)</span>
        <div className="frequency-axis" aria-hidden="true"><span>8</span><span>4</span><span>0</span></div>
        <div className="spectrogram-main">
            <div
              className="spectrogram-plot"
              data-image-url={track.spectrogram}
              role="slider"
              tabIndex={0}
              aria-label={`Seek ${track.label} audio`}
              aria-valuemin={0}
              aria-valuemax={10}
              aria-valuenow={Math.min(10, Number(position.toFixed(1)))}
              aria-valuetext={`${position.toFixed(1)} seconds`}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                seekTo(((event.clientX - bounds.left) / bounds.width) * 10);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowUp") seekTo(position + 1);
                else if (event.key === "ArrowLeft" || event.key === "ArrowDown") seekTo(position - 1);
                else if (event.key === "Home") seekTo(0);
                else if (event.key === "End") seekTo(10);
                else return;
                event.preventDefault();
              }}
            >
              <AudioSpectrogramImage url={track.spectrogram} label={track.label} onReady={() => setImageLoaded(true)} />
              {imageLoaded && <span className="spectrogram-cursor" style={{ left: `${Math.min(100, Math.max(0, position * 10))}%` }} aria-hidden="true" />}
            </div>
        </div>
        <div className="time-axis" aria-hidden="true"><span>0</span><span>5</span><span>10</span></div>
        <span className="time-caption" aria-hidden="true">Time (s)</span>
      </div>

      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={audioUrl}
        data-audio-url={track.audio}
        aria-label={`${track.label} audio`}
        onLoadedMetadata={loadMetadata}
        onTimeUpdate={(event) => {
          if (pendingSeekRef.current === null) updatePosition(event.currentTarget.currentTime);
        }}
        onPlay={(event) => {
          setAudioError(false);
          mediaCache.setBuffering(track.key, event.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
          onPlay(event.currentTarget);
        }}
        onWaiting={() => mediaCache.setBuffering(track.key, true)}
        onCanPlay={() => mediaCache.setBuffering(track.key, false)}
        onPause={(event) => pausePlayback(event.currentTarget)}
        onEnded={(event) => pausePlayback(event.currentTarget)}
        onError={(event) => {
          pausePlayback(event.currentTarget);
          setAudioError(true);
        }}
      />
      {audioError && <p className="asset-error" role="alert">Audio unavailable for this track.</p>}

      {track.metrics && (
        <div className="metric-area">
          <dl className="metric-grid">
            <div><dt>PESQ</dt><dd>{track.metrics.PESQ.toFixed(2)}</dd></div>
            <div><dt>ESTOI</dt><dd>{track.metrics.ESTOI.toFixed(3)}</dd></div>
            <div><dt>SI-SDR</dt><dd>{track.metrics.SISDR.toFixed(2)} dB</dd></div>
          </dl>
          {showNonIntrusive && (
            <dl className="metric-grid metric-grid--secondary">
              <div><dt>OVRL</dt><dd>{track.metrics.OVRL.toFixed(2)}</dd></div>
              <div><dt>SIG</dt><dd>{track.metrics.SIG.toFixed(2)}</dd></div>
              <div><dt>BAK</dt><dd>{track.metrics.BAK.toFixed(2)}</dd></div>
              <div><dt>P808</dt><dd>{track.metrics.P808_MOS.toFixed(2)}</dd></div>
            </dl>
          )}
        </div>
      )}
    </article>
  );
}

/** 在模式切换和异步内容就绪时平滑调整高度，并取消过期的淡入淡出。 */
function AnimatedSceneView({ mode, children }: { mode: SceneViewMode; children: (visibleMode: SceneViewMode) => ReactNode }) {
  const [visibleMode, setVisibleMode] = useState(mode);
  const [phase, setPhase] = useState<"idle" | "exiting" | "entering">("idle");
  const [height, setHeight] = useState<number>();
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const visibleModeRef = useRef(mode);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    /** 系统减少动态效果的变更立即作用于当前模式过渡。 */
    function updateMotion() { setReducedMotion(query.matches); }
    query.addEventListener("change", updateMotion);
    return () => query.removeEventListener("change", updateMotion);
  }, []);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    /** 跟随内部内容的真实高度，异步元数据和错误恢复也保持连续布局。 */
    function measure() { if (content) setHeight(content.getBoundingClientRect().height); }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    let frame: number | undefined;
    if (reducedMotion || mode === visibleModeRef.current) {
      visibleModeRef.current = mode;
      setVisibleMode(mode);
      setPhase("idle");
      return;
    }
    setPhase("exiting");
    timer = window.setTimeout(() => {
      visibleModeRef.current = mode;
      setVisibleMode(mode);
      setPhase("entering");
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setPhase("idle"));
      });
    }, 110);
    return () => {
      window.clearTimeout(timer);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [mode, reducedMotion]);

  return (
    <div className="scene-view-shell" style={{ height }}>
      <div ref={contentRef} className={`scene-view scene-view--${phase}`} data-mode={visibleMode} data-phase={phase} inert={phase !== "idle"} aria-busy={phase !== "idle"}>
        {children(visibleMode)}
      </div>
    </div>
  );
}

/** 独立管理一个难度区域的场景、模式及指标状态。 */
function SceneGroup({ split, scenes, sceneErrors, savedPosition, rememberPosition, onPlay, onPause, onSceneChange, onReloadScene }: SceneGroupProps) {
  const [selectedId, setSelectedId] = useState<SceneId>(split === "Easy" ? "easy-01" : "hard-01");
  const [detail, setDetail] = useState<SceneDetail | null>(null);
  const [showNonIntrusive, setShowNonIntrusive] = useState(false);
  const [viewMode, setViewMode] = useState<SceneViewMode>("audio");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const contentRegionRef = useRef<HTMLDivElement>(null);
  const datasetTitle = split === "Easy" ? "2D-Spatialized Dataset (Easy)" : "3D-Spatialized Dataset (Hard)";
  const options = sceneOptions.filter((option) => option.id.startsWith(`${split.toLowerCase()}-`));
  const scene = scenes[selectedId];
  const sceneError = sceneErrors[selectedId];
  const isSwitching = detail?.sceneId !== selectedId;
  const selectedIndex = options.findIndex((option) => option.id === selectedId);

  useEffect(() => {
    if (!scene && !sceneError) return;
    const controller = new AbortController();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let exitTimer: number;
    const exitReady = new Promise<void>((resolve) => {
      exitTimer = window.setTimeout(resolve, reducedMotion ? 0 : 120);
    });

    /** 只等待小型指标与短淡出，图片和音频由独立调度器准备。 */
    async function prepareDetail() {
      let nextDetail: SceneDetail;
      try {
        if (sceneError) throw new Error(sceneError);
        if (!scene) return;
        const cached = detailCache.get(selectedId);
        if (cached) nextDetail = cached;
        else {
          const rows = await loadMetrics(scene);
          nextDetail = { sceneId: selectedId, scene, tracks: buildTracks(scene, rows) };
          detailCache.set(selectedId, nextDetail);
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        nextDetail = { sceneId: selectedId, error: error instanceof Error ? error.message : "Quality metrics are unavailable." };
      }
      await exitReady;
      if (controller.signal.aborted) return;
      setShowNonIntrusive(false);
      setDetail(nextDetail);
    }

    void prepareDetail();
    return () => {
      controller.abort();
      window.clearTimeout(exitTimer);
    };
  }, [scene, sceneError, selectedId, retryAttempt]);

  /** 切换本区域场景时暂停播放，并恢复指标的默认折叠状态。 */
  function selectScene(id: SceneId) {
    if (id === selectedId) return;
    onSceneChange();
    setViewMode("audio");
    setShowNonIntrusive(false);
    setSelectedId(id);
  }

  /** 进入内部分析时只暂停本区音轨；返回时复用已保存的独立进度。 */
  function toggleView() {
    if (viewMode === "audio") {
      contentRegionRef.current?.querySelectorAll("audio").forEach((audio) => audio.pause());
      setViewMode("internals");
    } else setViewMode("audio");
  }

  /** 分别重试失败的场景清单或指标请求，不反复显示过期错误。 */
  function retryScene() {
    if (sceneError) { setDetail(null); onReloadScene(selectedId); }
    else setRetryAttempt((current) => current + 1);
  }

  return (
    <section className="scene-group" aria-labelledby={`${split.toLowerCase()}-scenes-title`}>
      <h3 className="scene-group-title" id={`${split.toLowerCase()}-scenes-title`}>{datasetTitle}</h3>
      <div className="scene-picker" role="group" aria-label={`Choose a ${split.toLowerCase()} audio scene`}>
        <span className="scene-picker-indicator" style={{ transform: `translateX(calc(${selectedIndex * 100}% + ${selectedIndex * 4}px))` }} aria-hidden="true" />
        {options.map((option) => {
          const item = scenes[option.id];
          return (
            <button
              className={`scene-choice${selectedId === option.id ? " scene-choice--active" : ""}`}
              type="button"
              key={option.id}
              aria-pressed={selectedId === option.id}
              onClick={() => selectScene(option.id)}
            >
              <strong>{option.label}</strong>
              <span>{item ? `${item.mixtureSpeakerCount} speakers` : sceneErrors[option.id] ? "Metadata unavailable" : "Loading scene…"}</span>
            </button>
          );
        })}
      </div>

      <div className="scene-detail-shell">
        <div className={`scene-detail${isSwitching ? " scene-detail--switching" : ""}`} aria-busy={isSwitching} inert={isSwitching}>
          {detail?.error ? (
            <div className="scene-message scene-message--error" role="alert"><p>{detail.error}</p><button type="button" className="metric-toggle" onClick={retryScene}>Retry scene</button></div>
          ) : detail?.scene && detail.tracks ? (
            <>
              <div className={`scene-detail-heading${split === "Easy" ? " scene-detail-heading--with-internals" : ""}`}>
                <h4>{options.find((option) => option.id === detail.sceneId)?.label}</h4>
                <div className="scene-detail-actions">
                  {viewMode === "audio" && (
                    <button
                      type="button"
                      className="metric-toggle"
                      aria-expanded={showNonIntrusive}
                      aria-controls={`${split.toLowerCase()}-track-grid`}
                      onClick={() => setShowNonIntrusive((current) => !current)}
                    >
                      {showNonIntrusive ? "Hide DNSMOS" : "Show DNSMOS"}
                    </button>
                  )}
                  {split === "Easy" && (
                    <button type="button" className="primary-button internals-toggle" aria-pressed={viewMode === "internals"} aria-controls="easy-scene-content" onClick={toggleView}>
                      {viewMode === "audio" ? "View Details" : "Back to Audio"}
                    </button>
                  )}
                </div>
              </div>
              <AcousticConditions scene={detail.scene} />
              <div ref={contentRegionRef} id={`${split.toLowerCase()}-scene-content`}>
                <AnimatedSceneView key={detail.sceneId} mode={viewMode}>
                  {(visibleMode) => visibleMode === "internals" ? (
                    <InternalVisualizations key={detail.sceneId} sceneId={detail.sceneId} sampleId={detail.scene!.sampleId} />
                  ) : (
                    <div className="audio-track-grid" id={`${split.toLowerCase()}-track-grid`}>
                      {detail.tracks!.map((track) => (
                        <TrackCard
                          key={track.key}
                          track={track}
                          showNonIntrusive={showNonIntrusive}
                          savedPosition={savedPosition}
                          rememberPosition={rememberPosition}
                          onPlay={onPlay}
                          onPause={onPause}
                        />
                      ))}
                    </div>
                  )}
                </AnimatedSceneView>
              </div>
            </>
          ) : null}
        </div>
        {isSwitching && (
          <p className={`scene-message scene-loading${detail ? " scene-loading--overlay" : ""}`} role="status">Loading audio scene…</p>
        )}
      </div>
    </section>
  );
}

/** 加载场景元数据，并在两个试听区域之间共享互斥播放与进度。 */
export default function AudioDemo() {
  const [scenes, setScenes] = useState<Partial<Record<SceneId, Scene>>>({});
  const [sceneErrors, setSceneErrors] = useState<Partial<Record<SceneId, string>>>({});
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const positions = useRef(new Map<string, number>());

  useEffect(() => {
    let live = true;
    for (const option of sceneOptions) {
      loadScene(option.id)
        .then((scene) => { if (live) setScenes((current) => ({ ...current, [option.id]: scene })); })
        .catch((error: unknown) => {
          if (!live) return;
          setSceneErrors((current) => ({ ...current, [option.id]: error instanceof Error ? error.message : "Scene metadata is unavailable." }));
        });
    }
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const defaults = ["easy-01", "hard-01"] as const;
    const remaining = ["easy-02", "easy-03", "hard-02", "hard-03"] as const;
    const resources = (ids: readonly SceneId[]) => ids.flatMap((id) => scenes[id] ? [sceneMedia(scenes[id]!)] : []);
    const initial = resources(defaults);
    const defaultsSettled = defaults.every((id) => scenes[id] || sceneErrors[id]);
    if (!initial.length && !defaultsSettled) return;
    const allSettled = sceneOptions.every((option) => scenes[option.id] || sceneErrors[option.id]);
    const later = defaultsSettled ? resources(remaining) : [];
    mediaCache.startPreload(initial.flatMap((scene) => scene.images), later.flatMap((scene) => scene.images), allSettled ? [...initial, ...later].flatMap((scene) => scene.audio) : []);
  }, [scenes, sceneErrors]);

  /** 重新读取失败的场景清单，保留其他场景已有数据与缓存。 */
  function reloadScene(id: SceneId) {
    setSceneErrors((current) => { const next = { ...current }; delete next[id]; return next; });
    void loadScene(id, true)
      .then((scene) => setScenes((current) => ({ ...current, [id]: scene })))
      .catch((error: unknown) => setSceneErrors((current) => ({ ...current, [id]: error instanceof Error ? error.message : "Scene metadata is unavailable." })));
  }

  /** 暂停上一音轨，确保两个区域之间同一时刻仅播放一条音频。 */
  function handlePlay(audio: HTMLAudioElement) {
    if (activeAudio.current && activeAudio.current !== audio) activeAudio.current.pause();
    activeAudio.current = audio;
  }

  /** 清除已暂停音轨的活动标记。 */
  function handlePause(audio: HTMLAudioElement) {
    if (activeAudio.current === audio) activeAudio.current = null;
  }

  /** 切换任一场景时停止正在播放的音轨。 */
  function stopActiveAudio() {
    activeAudio.current?.pause();
    activeAudio.current = null;
  }

  /** 获取音轨上次保存的播放位置。 */
  function savedPosition(key: string) {
    return positions.current.get(key) ?? 0;
  }

  /** 保存音轨当前的播放位置。 */
  function rememberPosition(key: string, seconds: number) {
    positions.current.set(key, seconds);
  }

  return (
    <div className="audio-demo">
      <SceneGroup split="Easy" scenes={scenes} sceneErrors={sceneErrors} savedPosition={savedPosition} rememberPosition={rememberPosition} onPlay={handlePlay} onPause={handlePause} onSceneChange={stopActiveAudio} onReloadScene={reloadScene} />
      <SceneGroup split="Hard" scenes={scenes} sceneErrors={sceneErrors} savedPosition={savedPosition} rememberPosition={rememberPosition} onPlay={handlePlay} onPause={handlePause} onSceneChange={stopActiveAudio} onReloadScene={reloadScene} />
    </div>
  );
}
