// 实录与仿真分区试听：实录使用十五秒轴，仿真使用十秒轴，图片独立加载与重试。
// 三个区域共享原生播放器、独立进度、互斥播放和分阶段媒体预取。
// 实录增强卡仅展示 P808_MOS；仿真保留原指标和 Easy 内部分析模式。
// 三个区域默认折叠且互斥展开，首开才加载；收起保留状态，锚点入口自动展开目标。
// 展开后等待布局稳定再将区域标题对齐导航栏下方，用户主动滚动时停止自动定位。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import InternalVisualizations from "./InternalVisualizations";
import RealRecordings, { loadRealRecording, realRecordingMedia, type RealRecording } from "./RealRecordings";
import { optimizedImageUrl } from "./imageAssets";
import { mediaCache } from "./mediaCache";

type SceneViewMode = "audio" | "internals";
const demoSectionIds = ["real-recordings", "easy-samples", "hard-samples"] as const;
type DemoSectionId = (typeof demoSectionIds)[number];
const closedSections: Record<DemoSectionId, boolean> = { "real-recordings": false, "easy-samples": false, "hard-samples": false };

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
  durationS?: number;
  accessibilityLabel?: string;
  p808Mos?: number;
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

/** 将仿真场景映射到对应的折叠区域。 */
function simulationSectionId(id: SceneId): DemoSectionId {
  return id.startsWith("easy") ? "easy-samples" : "hard-samples";
}

/** 收起区域时暂停音轨并关闭内部大图，保留进度和视图状态且释放模态焦点。 */
function deactivateSection(id: DemoSectionId): void {
  const section = document.getElementById(id);
  section?.querySelectorAll("audio").forEach((audio) => audio.pause());
  section?.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((dialog) => dialog.close());
}

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
  const durationS = track.durationS ?? 10;
  const accessibilityLabel = track.accessibilityLabel ?? track.label;
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
    const availableDuration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? Math.min(audio.duration, durationS) : durationS;
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
    <article className={`audio-track-card${track.label.includes("CORE") ? " audio-track-card--core" : ""}`} data-track-key={track.key}>
      <div className="audio-track-heading">
        <h5>{track.label}</h5>
      </div>

      <div className="spectrogram" aria-label={`${accessibilityLabel} spectrogram, 0 to ${durationS} seconds and 0 to 8 kilohertz`}>
        <span className="frequency-label" aria-hidden="true">Frequency (kHz)</span>
        <div className="frequency-axis" aria-hidden="true"><span>8</span><span>4</span><span>0</span></div>
        <div className="spectrogram-main">
            <div
              className="spectrogram-plot"
              data-image-url={track.spectrogram}
              role="slider"
              tabIndex={0}
              aria-label={`Seek ${accessibilityLabel} audio`}
              aria-valuemin={0}
              aria-valuemax={durationS}
              aria-valuenow={Math.min(durationS, Number(position.toFixed(1)))}
              aria-valuetext={`${position.toFixed(1)} seconds`}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                seekTo(((event.clientX - bounds.left) / bounds.width) * durationS);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowUp") seekTo(position + 1);
                else if (event.key === "ArrowLeft" || event.key === "ArrowDown") seekTo(position - 1);
                else if (event.key === "Home") seekTo(0);
                else if (event.key === "End") seekTo(durationS);
                else return;
                event.preventDefault();
              }}
            >
              <AudioSpectrogramImage url={track.spectrogram} label={accessibilityLabel} onReady={() => setImageLoaded(true)} />
              {imageLoaded && <span className="spectrogram-cursor" style={{ left: `${Math.min(100, Math.max(0, position / durationS * 100))}%` }} aria-hidden="true" />}
            </div>
        </div>
        <div className="time-axis" aria-hidden="true"><span>0</span><span>{durationS / 2}</span><span>{durationS}</span></div>
        <span className="time-caption" aria-hidden="true">Time (s)</span>
      </div>

      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={audioUrl}
        data-audio-url={track.audio}
        aria-label={`${accessibilityLabel} audio`}
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

      {track.p808Mos !== undefined && (
        <div className="metric-area">
          <dl className="metric-grid metric-grid--single">
            <div><dt>P808_MOS</dt><dd>{track.p808Mos.toFixed(2)}</dd></div>
          </dl>
        </div>
      )}

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

/** 使用可键盘操作的标题按钮展开区域，收起后保留已挂载内容的状态。 */
function CollapsibleDemoSection({ id, title, open, onToggle, className = "", children }: {
  id: DemoSectionId;
  title: string;
  open: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`scene-group ${className}`.trim()} id={id} aria-labelledby={`${id}-title`}>
      <h3 className="scene-group-title" id={`${id}-title`}>
        <button className="demo-section-toggle" type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={onToggle}>
          <span>{title}</span>
          <svg className="demo-section-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </h3>
      <div className={`demo-section-panel${open ? " demo-section-panel--open" : ""}`} id={`${id}-panel`} data-open={open} role="region" aria-labelledby={`${id}-title`} aria-hidden={!open} inert={!open}>
        <div className="demo-section-panel-inner">{children}</div>
      </div>
    </section>
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
    <div className="scene-group-content">
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
    </div>
  );
}

/** 独立加载实录和仿真清单，在三个区域之间共享播放与媒体调度。 */
export default function AudioDemo() {
  const [openSections, setOpenSections] = useState(closedSections);
  const [visitedSections, setVisitedSections] = useState(closedSections);
  const [scenes, setScenes] = useState<Partial<Record<SceneId, Scene>>>({});
  const [sceneErrors, setSceneErrors] = useState<Partial<Record<SceneId, string>>>({});
  const [recording, setRecording] = useState<RealRecording>();
  const [recordingError, setRecordingError] = useState<string>();
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const positions = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const id = demoSectionIds.find((sectionId) => openSections[sectionId]);
    const section = id ? document.getElementById(id) : null;
    const demo = section?.parentElement;
    if (!section || !demo) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let stopped = false;
    let frame: number | undefined;
    let scrollTimer: number | undefined;
    let deadline: number | undefined;
    const observer = new ResizeObserver(scheduleAlignment);

    /** 完成定位或收到用户操作后释放临时观察，不干扰后续试听与阅读。 */
    function stopAlignment() {
      stopped = true;
      observer.disconnect();
      window.clearTimeout(scrollTimer);
      window.clearTimeout(deadline);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("wheel", stopAlignment);
      window.removeEventListener("touchmove", stopAlignment);
      window.removeEventListener("pointerdown", stopAlignment);
      window.removeEventListener("keydown", cancelForScrollKey);
    }

    /** 用户使用滚动按键时取消尚未发生的自动定位。 */
    function cancelForScrollKey(event: KeyboardEvent) {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) stopAlignment();
    }

    /** 在浏览器完成两轮布局后，以固定导航栏和锚点偏移共同确定标题位置。 */
    function alignSection() {
      if (stopped) return;
      observer.disconnect();
      window.clearTimeout(scrollTimer);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          if (stopped || !section) return;
          const headerBottom = document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0;
          const offset = Math.max(headerBottom + 12, Number.parseFloat(getComputedStyle(section).scrollMarginTop) || 0);
          const top = Math.max(0, window.scrollY + section.getBoundingClientRect().top - offset);
          window.scrollTo({ top, behavior: reduced ? "instant" : "smooth" });
          stopAlignment();
        });
      });
    }

    /** 折叠和异步详情改变高度时重新等待，避免沿用旧文档高度计算滚动位置。 */
    function scheduleAlignment() {
      if (stopped) return;
      window.clearTimeout(scrollTimer);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      scrollTimer = window.setTimeout(alignSection, reduced ? 0 : 80);
    }

    observer.observe(demo);
    scheduleAlignment();
    deadline = window.setTimeout(alignSection, 1200);
    window.addEventListener("wheel", stopAlignment, { passive: true });
    window.addEventListener("touchmove", stopAlignment, { passive: true });
    window.addEventListener("pointerdown", stopAlignment, { passive: true });
    window.addEventListener("keydown", cancelForScrollKey);
    return stopAlignment;
  }, [openSections]);

  useEffect(() => {

    /** 自动收起其他区域并展开锚点目标，滚动由统一的布局定位逻辑处理。 */
    function revealSection(id: DemoSectionId) {
      demoSectionIds.filter((other) => other !== id).forEach(deactivateSection);
      setVisitedSections((current) => current[id] ? current : { ...current, [id]: true });
      setOpenSections({ ...closedSections, [id]: true });
    }

    /** 直接链接和浏览器历史导航均展开其指向的试听区域。 */
    function followHash() {
      const id = window.location.hash.slice(1);
      if (demoSectionIds.includes(id as DemoSectionId)) revealSection(id as DemoSectionId);
    }

    /** 页首入口即使重复点击相同锚点，也能重新展开已收起的区域。 */
    function followSectionLink(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      const href = link?.getAttribute("href");
      if (!href?.startsWith("#") || !demoSectionIds.includes(href.slice(1) as DemoSectionId)) return;
      event.preventDefault();
      if (window.location.hash !== href) window.history.pushState(null, "", href);
      revealSection(href.slice(1) as DemoSectionId);
    }

    followHash();
    window.addEventListener("hashchange", followHash);
    document.addEventListener("click", followSectionLink);
    return () => {
      window.removeEventListener("hashchange", followHash);
      document.removeEventListener("click", followSectionLink);
    };
  }, []);

  useEffect(() => {
    let live = true;
    if (visitedSections["real-recordings"]) {
      loadRealRecording()
        .then((value) => { if (live) { setRecording(value); setRecordingError(undefined); } })
        .catch((error: unknown) => { if (live) setRecordingError(error instanceof Error ? error.message : "Real recording metadata is unavailable."); });
    }
    for (const option of sceneOptions) {
      if (!visitedSections[simulationSectionId(option.id)]) continue;
      loadScene(option.id)
        .then((scene) => {
          if (!live) return;
          setScenes((current) => ({ ...current, [option.id]: scene }));
          setSceneErrors((current) => {
            if (!current[option.id]) return current;
            const next = { ...current };
            delete next[option.id];
            return next;
          });
        })
        .catch((error: unknown) => {
          if (!live) return;
          setSceneErrors((current) => ({ ...current, [option.id]: error instanceof Error ? error.message : "Scene metadata is unavailable." }));
        });
    }
    return () => { live = false; };
  }, [visitedSections]);

  useEffect(() => {
    if (!demoSectionIds.some((id) => visitedSections[id])) return;
    const defaults = (["easy-01", "hard-01"] as const).filter((id) => visitedSections[simulationSectionId(id)]);
    const remaining = (["easy-02", "easy-03", "hard-02", "hard-03"] as const).filter((id) => visitedSections[simulationSectionId(id)]);
    const resources = (ids: readonly SceneId[]) => ids.flatMap((id) => scenes[id] ? [sceneMedia(scenes[id]!)] : []);
    const initial = [...(visitedSections["real-recordings"] && recording ? [realRecordingMedia(recording)] : []), ...resources(defaults)];
    const recordingSettled = !visitedSections["real-recordings"] || Boolean(recording || recordingError);
    const defaultsSettled = recordingSettled && defaults.every((id) => scenes[id] || sceneErrors[id]);
    if (!initial.length && !defaultsSettled) return;
    const allSettled = recordingSettled && sceneOptions.filter((option) => visitedSections[simulationSectionId(option.id)]).every((option) => scenes[option.id] || sceneErrors[option.id]);
    const later = defaultsSettled ? resources(remaining) : [];
    mediaCache.startPreload(initial.flatMap((scene) => scene.images), later.flatMap((scene) => scene.images), allSettled ? [...initial, ...later].flatMap((scene) => scene.audio) : []);
  }, [scenes, sceneErrors, recording, recordingError, visitedSections]);

  /** 打开新区时收起并暂停旧区，同一区域再次点击则全部收起。 */
  function toggleSection(id: DemoSectionId) {
    demoSectionIds.forEach(deactivateSection);
    setVisitedSections((current) => current[id] ? current : { ...current, [id]: true });
    setOpenSections((current) => current[id] ? closedSections : { ...closedSections, [id]: true });
  }

  /** 单独重试实录清单，不影响仿真场景及已经缓存的媒体。 */
  function reloadRecording() {
    setRecordingError(undefined);
    void loadRealRecording(true)
      .then(setRecording)
      .catch((error: unknown) => setRecordingError(error instanceof Error ? error.message : "Real recording metadata is unavailable."));
  }

  /** 重新读取失败的场景清单，保留其他场景已有数据与缓存。 */
  function reloadScene(id: SceneId) {
    setSceneErrors((current) => { const next = { ...current }; delete next[id]; return next; });
    void loadScene(id, true)
      .then((scene) => setScenes((current) => ({ ...current, [id]: scene })))
      .catch((error: unknown) => setSceneErrors((current) => ({ ...current, [id]: error instanceof Error ? error.message : "Scene metadata is unavailable." })));
  }

  /** 暂停上一音轨，确保三个区域之间同一时刻仅播放一条音频。 */
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
      <CollapsibleDemoSection id="real-recordings" title="Real Recordings" className="real-recordings" open={openSections["real-recordings"]} onToggle={() => toggleSection("real-recordings")}>
        {visitedSections["real-recordings"] && <RealRecordings recording={recording} error={recordingError} onRetry={reloadRecording} renderTrack={(track) => (
          <TrackCard track={track} showNonIntrusive={false} savedPosition={savedPosition} rememberPosition={rememberPosition} onPlay={handlePlay} onPause={handlePause} />
        )} />}
      </CollapsibleDemoSection>
      <CollapsibleDemoSection id="easy-samples" title="Simulated (Easy)" open={openSections["easy-samples"]} onToggle={() => toggleSection("easy-samples")}>
        {visitedSections["easy-samples"] && <SceneGroup split="Easy" scenes={scenes} sceneErrors={sceneErrors} savedPosition={savedPosition} rememberPosition={rememberPosition} onPlay={handlePlay} onPause={handlePause} onSceneChange={stopActiveAudio} onReloadScene={reloadScene} />}
      </CollapsibleDemoSection>
      <CollapsibleDemoSection id="hard-samples" title="Simulated (Hard)" open={openSections["hard-samples"]} onToggle={() => toggleSection("hard-samples")}>
        {visitedSections["hard-samples"] && <SceneGroup split="Hard" scenes={scenes} sceneErrors={sceneErrors} savedPosition={savedPosition} rememberPosition={rememberPosition} onPlay={handlePlay} onPause={handlePause} onSceneChange={stopActiveAudio} onReloadScene={reloadScene} />}
      </CollapsibleDemoSection>
    </div>
  );
}
