// 按论文数据集名称分区展示试听；恢复浏览器原生播放器并移除 Clean 的 Reference 标记。
// 保留跨场景进度和语谱图联动；场景切换时保留原布局，待图像就绪后平滑更新。
// Easy 新增独立内部分析模式，保留音频进度、指标展开状态及 Hard 播放隔离。
// Easy 与 Hard 统一使用简洁 DNSMOS 按钮文案，展开和收起逻辑不变。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import InternalVisualizations from "./InternalVisualizations";

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
}

const metricNames: MetricName[] = ["PESQ", "ESTOI", "SISDR", "OVRL", "SIG", "BAK", "P808_MOS"];

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

/** 按论文试听顺序将场景清单映射为当前应展示的音轨。 */
function buildTracks(scene: Scene, metrics: Record<string, MetricRow>): Track[] {
  const sceneId = scene.id as SceneId;
  const tracks: Track[] = [
    {
      key: `${sceneId}:unprocessed`,
      label: "Unprocessed",
      kind: "unprocessed",
      audio: sceneAssetUrl(sceneId, scene.mixtureAudio),
      spectrogram: sceneAssetUrl(sceneId, scene.mixtureSpectrogram),
    },
    {
      key: `${sceneId}:clean`,
      label: "Clean",
      kind: "clean",
      audio: sceneAssetUrl(sceneId, scene.target.cleanAudio),
      spectrogram: sceneAssetUrl(sceneId, scene.target.cleanSpectrogram),
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
      spectrogram: sceneAssetUrl(sceneId, experiment.spectrogram),
      metrics: row,
    });
  }
  return tracks;
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
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (audio) {
        audio.pause();
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
          {imageError ? (
            <p className="asset-error spectrogram-error" role="alert">Spectrogram unavailable for this track.</p>
          ) : (
            <div
              className="spectrogram-plot"
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
              <img src={track.spectrogram} alt="" loading="lazy" draggable={false} onError={() => setImageError(true)} />
              <span className="spectrogram-cursor" style={{ left: `${Math.min(100, Math.max(0, position * 10))}%` }} aria-hidden="true" />
            </div>
          )}
        </div>
        <div className="time-axis" aria-hidden="true"><span>0</span><span>5</span><span>10</span></div>
        <span className="time-caption" aria-hidden="true">Time (s)</span>
      </div>

      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={track.audio}
        aria-label={`${track.label} audio`}
        onLoadedMetadata={loadMetadata}
        onTimeUpdate={(event) => {
          if (pendingSeekRef.current === null) updatePosition(event.currentTarget.currentTime);
        }}
        onPlay={(event) => {
          setAudioError(false);
          onPlay(event.currentTarget);
        }}
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
function SceneGroup({ split, scenes, sceneErrors, savedPosition, rememberPosition, onPlay, onPause, onSceneChange }: SceneGroupProps) {
  const [selectedId, setSelectedId] = useState<SceneId>(split === "Easy" ? "easy-01" : "hard-01");
  const [detail, setDetail] = useState<SceneDetail | null>(null);
  const [showNonIntrusive, setShowNonIntrusive] = useState(false);
  const [viewMode, setViewMode] = useState<SceneViewMode>("audio");
  const contentRegionRef = useRef<HTMLDivElement>(null);
  const datasetTitle = split === "Easy" ? "2D-Spatialized Dataset (Easy)" : "3D-Spatialized Dataset (Hard)";
  const options = sceneOptions.filter((option) => option.id.startsWith(`${split.toLowerCase()}-`));
  const scene = scenes[selectedId];
  const sceneError = sceneErrors[selectedId];
  const isSwitching = detail?.sceneId !== selectedId;
  const selectedIndex = options.findIndex((option) => option.id === selectedId);

  useEffect(() => {
    if ((!scene && !sceneError) || detail?.sceneId === selectedId) return;
    const controller = new AbortController();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let exitTimer: number;
    const exitReady = new Promise<void>((resolve) => {
      exitTimer = window.setTimeout(resolve, reducedMotion ? 0 : 120);
    });

    /** 并行准备指标和图像，淡出完成后一次性替换详情；忽略已取消的选择。 */
    async function prepareDetail() {
      let nextDetail: SceneDetail;
      try {
        if (sceneError) throw new Error(sceneError);
        if (!scene) return;
        const response = await fetch(sceneAssetUrl(selectedId, scene.enhancedMetricsFile), { signal: controller.signal });
        if (!response.ok) throw new Error(`Quality metrics could not be loaded (${response.status}).`);
        const rows = parseMetricsCsv(await response.text());
        const tracks = buildTracks(scene, rows);
        await Promise.all(tracks.map(async (track) => {
          const image = new Image();
          image.src = track.spectrogram;
          await image.decode().catch(() => undefined);
        }));
        nextDetail = { sceneId: selectedId, scene, tracks };
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
  }, [scene, sceneError, selectedId, detail?.sceneId]);

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
            <p className="scene-message scene-message--error" role="alert">{detail.error}</p>
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
                      {viewMode === "audio" ? "View Internals" : "Back to Audio"}
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
    const controller = new AbortController();
    for (const option of sceneOptions) {
      fetch(sceneAssetUrl(option.id, "scene.json"), { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Scene metadata could not be loaded (${response.status}).`);
          const payload = parseScene(await response.json(), option.id);
          setScenes((current) => ({ ...current, [option.id]: payload }));
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setSceneErrors((current) => ({ ...current, [option.id]: error instanceof Error ? error.message : "Scene metadata is unavailable." }));
        });
    }
    return () => controller.abort();
  }, []);

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
      <SceneGroup split="Easy" scenes={scenes} sceneErrors={sceneErrors} savedPosition={savedPosition} rememberPosition={rememberPosition} onPlay={handlePlay} onPause={handlePause} onSceneChange={stopActiveAudio} />
      <SceneGroup split="Hard" scenes={scenes} sceneErrors={sceneErrors} savedPosition={savedPosition} rememberPosition={rememberPosition} onPlay={handlePlay} onPause={handlePause} onSceneChange={stopActiveAudio} />
    </div>
  );
}
