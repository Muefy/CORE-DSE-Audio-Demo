// Easy 内部分析视图：独立读取元数据，逐图加载，并提供带坐标的大图弹窗。
// 注意力和掩码改为每图独立色条，语谱图不显示色条；精简分组标题并统一 head 名称。
// 区域说明概括提取过程的可视化内容，详细实验来源继续保存于素材元数据。
// 掩码与语谱图合并展示，在两个区域的图片下方补充与论文定义一致的图义说明。
import { useEffect, useId, useRef, useState } from "react";

interface ColorScale {
  min: number;
  max: number;
}

interface InternalPlot {
  filename: string;
  source: "core" | "probe" | "clean" | "enhanced";
  kind: string;
  branch?: string;
  head_index?: number;
  min: number;
  max: number;
}

interface InternalMetadata {
  scene_id: string;
  sample_id: string;
  experiment: string;
  is_current_demo_id9: boolean;
  grid: { time_range_s: number[]; frequency_range_khz: number[] };
  image: { width_px: number; height_px: number; colormap: string };
  attention_color_scale: ColorScale;
  mask_color_scale: ColorScale & { percentile: number };
  spectrograms: { clean: string; enhanced: string };
  spectrogram_color_scale: ColorScale & { reference_peak: number };
  plots: InternalPlot[];
}

interface PlotView {
  title: string;
  filename: string;
  scale: ColorScale;
  scaleKind: "attention" | "mask" | "spectrogram";
}

const metadataCache = new Map<string, InternalMetadata>();
const colorbarUrl = `${import.meta.env.BASE_URL}assets/inferno-colorbar.png`;

/** 校验来源、轴范围和色标，拒绝错误实验或不完整的内部素材。 */
function parseInternalMetadata(raw: unknown, sceneId: string, sampleId: string): InternalMetadata {
  const data = raw as InternalMetadata;
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const filename = (value: unknown) => typeof value === "string" && /^[a-z0-9_]+\.png$/.test(value);
  const range = (value: unknown, max: number) => Array.isArray(value) && value.length === 2 && value[0] === 0 && value[1] === max;
  const attention = data?.attention_color_scale;
  const mask = data?.mask_color_scale;
  const spectrogram = data?.spectrogram_color_scale;
  if (
    !/^easy-0[123]$/.test(sceneId) || data?.scene_id !== sceneId || data.sample_id !== sampleId ||
    data.experiment !== "MoDiX_JNF_v4_CEProbe_2026-09-08-01h32m" || data.is_current_demo_id9 !== false ||
    !range(data.grid?.time_range_s, 10) || !range(data.grid?.frequency_range_khz, 8) ||
    data.image?.width_px !== 1200 || data.image.height_px !== 493 || data.image.colormap !== "inferno" ||
    attention?.min !== 0 || attention.max !== 1 || mask?.min !== 0 || !finite(mask.max) || mask.max <= 0 || mask.percentile !== 99 ||
    spectrogram?.min !== -80 || spectrogram.max !== 0 || !finite(spectrogram.reference_peak) || spectrogram.reference_peak <= 0 ||
    !filename(data.spectrograms?.clean) || !filename(data.spectrograms?.enhanced) || !Array.isArray(data.plots)
  ) throw new Error("Internal metadata is incomplete or does not match this CE-Probe analysis.");

  for (let head = 0; head < 4; head += 1) {
    const matches = data.plots.filter((plot) => plot.branch === "spatial" && plot.head_index === head);
    if (matches.length !== 1 || !filename(matches[0]?.filename) || matches[0]?.source !== "core" ||
      matches[0]?.kind !== "tf_gca_gate" || matches[0]?.min !== 0 || matches[0]?.max !== 1) {
      throw new Error(`TF-GCA Map Head-${head + 1} is missing or has an inconsistent color scale.`);
    }
  }
  for (const source of ["probe", "core"] as const) {
    const matches = data.plots.filter((plot) => plot.kind === "complex_mask_magnitude" && plot.source === source);
    if (matches.length !== 1 || !filename(matches[0]?.filename) || matches[0]?.min !== 0 || matches[0]?.max !== mask.max) {
      throw new Error("The two magnitude masks must use the same joint percentile scale.");
    }
  }
  return data;
}

/** 为注意力或掩码单图呈现 inferno 色条，语谱图不显示色条。 */
function PlotColorbar({ plot }: { plot: PlotView }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (plot.scaleKind === "spectrogram") return null;
  const { min, max } = plot.scale;
  const values = [min, (min + max) / 2, max];
  const format = (value: number) => plot.scaleKind === "mask" ? value.toFixed(3) : String(value);
  const label = plot.scaleKind === "attention" ? "Attention weight" : "Mask magnitude";
  return (
    <div className="internal-colorbar" data-min={min} data-max={max} aria-label={`${plot.title}: ${label}, ${min} to ${max}`}>
      {failed ? (
        <div className="colorbar-error" role="alert">
          <span>Colorbar could not be loaded.</span>
          <button className="metric-toggle" type="button" aria-label={`Retry ${plot.title} colorbar`} onClick={() => { setFailed(false); setAttempt((current) => current + 1); }}>Retry colorbar</button>
        </div>
      ) : <img key={attempt} src={attempt ? `${colorbarUrl}?retry=${attempt}` : colorbarUrl} alt="" width={256} height={16} onError={() => setFailed(true)} />}
      <div className="colorbar-ticks" aria-hidden="true">{values.map((value) => <span key={value}>{format(value)}</span>)}</div>
      <span className="colorbar-label">{label}</span>
    </div>
  );
}

/** 在接近视口后请求单张图，保留固定比例并提供独立失败重试。 */
function InternalImage({ plot, url, onEnlarge, immediate = false }: {
  plot: PlotView;
  url: string;
  onEnlarge?: (opener: HTMLButtonElement) => void;
  immediate?: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const [requested, setRequested] = useState(immediate);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (requested || !surfaceRef.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRequested(true);
        observer.disconnect();
      }
    }, { rootMargin: "120px" });
    observer.observe(surfaceRef.current);
    return () => observer.disconnect();
  }, [requested]);

  useEffect(() => () => { generation.current += 1; }, []);

  /** 忽略卸载或重试前的解码回调，避免过期图片重新显现。 */
  async function imageLoaded(image: HTMLImageElement) {
    const current = generation.current;
    try {
      await image.decode();
      if (current === generation.current) setLoaded(true);
    } catch {
      if (current === generation.current) setFailed(true);
    }
  }

  /** 只重试当前失败图片，不重载元数据和其他图。 */
  function retry() {
    generation.current += 1;
    setLoaded(false);
    setFailed(false);
    setAttempt((current) => current + 1);
  }

  const image = requested && !failed ? (
    <img
      key={attempt}
      src={attempt ? `${url}?retry=${attempt}` : url}
      alt={plot.title}
      width={1200}
      height={493}
      draggable={false}
      className={loaded ? "internal-image internal-image--loaded" : "internal-image"}
      onLoad={(event) => { void imageLoaded(event.currentTarget); }}
      onError={() => setFailed(true)}
    />
  ) : null;

  return (
    <div className="internal-image-surface" ref={surfaceRef} aria-busy={!loaded && !failed}>
      {failed ? (
        <div className="internal-image-status internal-image-status--error" role="alert">
          <span>{plot.title} could not be loaded.</span>
          <button className="metric-toggle" type="button" aria-label={`Retry ${plot.title} image`} onClick={retry}>Retry image</button>
        </div>
      ) : (
        <>
          {onEnlarge ? (
            <button className="internal-plot-button" type="button" aria-label={`Enlarge ${plot.title}`} disabled={!loaded} onClick={(event) => onEnlarge(event.currentTarget)}>{image}</button>
          ) : image}
          {!loaded && <span className="internal-image-status" role="status">{requested ? "Loading image…" : "Image loads when in view"}</span>}
        </>
      )}
    </div>
  );
}

/** 为纯绘图区补充统一时频坐标，不增加音频或时间跳转交互。 */
function StaticPlot({ plot, url, onEnlarge, immediate }: {
  plot: PlotView;
  url: string;
  onEnlarge?: (opener: HTMLButtonElement) => void;
  immediate?: boolean;
}) {
  return (
    <div className="spectrogram internal-axes" aria-label={`${plot.title}, 0 to 10 seconds and 0 to 8 kilohertz`}>
      <span className="frequency-label" aria-hidden="true">Frequency (kHz)</span>
      <div className="frequency-axis" aria-hidden="true"><span>8</span><span>4</span><span>0</span></div>
      <div className="spectrogram-main"><InternalImage plot={plot} url={url} onEnlarge={onEnlarge} immediate={immediate} /></div>
      <div className="time-axis" aria-hidden="true"><span>0</span><span>5</span><span>10</span></div>
      <span className="time-caption" aria-hidden="true">Time (s)</span>
    </div>
  );
}

/** 展示白底大图并在关闭时恢复触发按钮焦点。 */
function PlotDialog({ selection, baseUrl, onClose }: {
  selection: { plot: PlotView; opener: HTMLButtonElement };
  baseUrl: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (selection.opener.isConnected) selection.opener.focus({ preventScroll: true });
    };
  }, [selection]);

  /** 在对话框首尾循环 Tab 焦点，避免仅有一个按钮时焦点落入浏览器外框。 */
  function keepFocus(event: React.KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])"))
      .filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (first && last && ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first))) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
  return (
    <dialog
      ref={dialogRef}
      className="method-dialog internal-dialog"
      aria-labelledby={titleId}
      onKeyDown={keepFocus}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="dialog-shell">
        <div className="dialog-topbar"><h2 id={titleId}>{selection.plot.title}</h2><button type="button" className="icon-button" aria-label="Close internal image" onClick={onClose}>×</button></div>
        <div className="dialog-content">
          <StaticPlot plot={selection.plot} url={`${baseUrl}${selection.plot.filename}`} immediate />
          <PlotColorbar plot={selection.plot} />
        </div>
      </div>
    </dialog>
  );
}

/** 按注意力及掩码／语谱图两组展示八张图，成功元数据在本次页面会话中复用。 */
export default function InternalVisualizations({ sceneId, sampleId }: { sceneId: string; sampleId: string }) {
  const [metadata, setMetadata] = useState<InternalMetadata | null>(() => metadataCache.get(sceneId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<{ plot: PlotView; opener: HTMLButtonElement } | null>(null);
  const baseUrl = `${import.meta.env.BASE_URL}assets/scenes/${sceneId}/internal/`;

  useEffect(() => {
    const cached = metadataCache.get(sceneId);
    if (cached) { setMetadata(cached); return; }
    const controller = new AbortController();
    setError(null);
    fetch(`${baseUrl}metadata.json`, { signal: controller.signal, cache: attempt ? "reload" : "default" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Internal metadata could not be loaded (${response.status}).`);
        const next = parseInternalMetadata(await response.json(), sceneId, sampleId);
        if (controller.signal.aborted) return;
        metadataCache.set(sceneId, next);
        setMetadata(next);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Internal metadata is unavailable.");
      });
    return () => controller.abort();
  }, [sceneId, sampleId, baseUrl, attempt]);

  if (error) return <div className="scene-message scene-message--error" role="alert"><p>{error}</p><button className="metric-toggle" type="button" aria-label="Retry internal metadata" onClick={() => setAttempt((current) => current + 1)}>Retry metadata</button></div>;
  if (!metadata) return <p className="scene-message" role="status">Loading internal analysis…</p>;

  const groups: { title: string; description: string; plots: PlotView[] }[] = [
    {
      title: "TF-GCA Maps",
      description: "The four spatial-branch maps visualize learned compatibility between the target direction and local inter-channel phase difference (IPD) features. Brighter colors indicate larger sigmoid gate values, which apply larger weights to the corresponding value features. Gates are computed independently at each time–frequency bin, while different heads learn complementary matching patterns without softmax competition across bins.",
      plots: [0, 1, 2, 3].map((head) => ({ title: `TF-GCA Map Head-${head + 1}`, filename: metadata.plots.find((plot) => plot.branch === "spatial" && plot.head_index === head)!.filename, scale: metadata.attention_color_scale, scaleKind: "attention" })),
    },
    {
      title: "Mask and Spectrogram Comparison",
      description: "The CE-Probe mask is estimated by a trained 1×1 readout of frozen Coarse Extractor (CE) features, visualizing the coarse target representation. The Fine Enhancer (FE) refines the CE representation to suppress residual interference and restore speech detail; the CORE mask shows the full model’s final estimate. Both maps display complex-mask magnitudes on the same scale, and the spectrograms compare the clean reference with the enhanced output.",
      plots: [
        ...(["probe", "core"] as const).map((source): PlotView => ({ title: source === "probe" ? "CE-Probe magnitude mask" : "CORE magnitude mask", filename: metadata.plots.find((plot) => plot.kind === "complex_mask_magnitude" && plot.source === source)!.filename, scale: metadata.mask_color_scale, scaleKind: "mask" })),
        ...(["clean", "enhanced"] as const).map((kind): PlotView => ({ title: kind === "clean" ? "Clean spectrogram" : "Enhanced spectrogram", filename: metadata.spectrograms[kind], scale: metadata.spectrogram_color_scale, scaleKind: "spectrogram" })),
      ],
    },
  ];

  return (
    <section className="internal-view" aria-labelledby={`${sceneId}-internals-title`}>
      <header className="internal-view-heading"><h4 id={`${sceneId}-internals-title`}>Inside CORE</h4><p>Visualizing CORE’s speech extraction process through TF-GCA maps, magnitude masks, and spectrograms.</p></header>
      {groups.map((group) => (
        <section className="internal-group" key={group.title} aria-label={group.title}>
          <div className="internal-plot-grid">
            {group.plots.map((plot) => (
              <figure className="internal-plot-card" key={plot.filename}>
                <h6>{plot.title}</h6>
                <StaticPlot plot={plot} url={`${baseUrl}${plot.filename}`} onEnlarge={(opener) => setSelection({ plot, opener })} />
                <PlotColorbar plot={plot} />
              </figure>
            ))}
          </div>
          <p className="internal-group-description">{group.description}</p>
        </section>
      ))}
      {selection && <PlotDialog selection={selection} baseUrl={baseUrl} onClose={() => setSelection(null)} />}
    </section>
  );
}
