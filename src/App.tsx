// 构建论文首页、逐层浏览的方法图和按场景切换的试听区；方法弹窗使用精简标题。
import { useEffect, useRef, useState } from "react";
import AudioDemo from "./AudioDemo";

type MethodPanel = "coarse-extractor" | "tfgca-lgm" | null;

const abstractText =
  "Direction of arrival (DOA) is a natural cue for multichannel directional speech extraction (DSE), but its few global geometric variables are mismatched with dense time-frequency acoustic representations, limiting the performance of existing DSE methods. We propose CORE-DSE, a coarse extraction and refinement framework that addresses this representation-granularity mismatch. Specifically, the Coarse Extractor (CE) combines Time-Frequency Gated Cross-Attention (TF-GCA), which models the relevance of DOA to individual time-frequency units, with a Local Gated Mixer (LGM) to produce direction-aware spectral and spatial representations. A Fine Enhancer (FE) then suppresses residual interference and restores target speech. Experiments show that CORE-DSE consistently outperforms physics-informed and generic DOA conditioning baselines while incurring only marginal computational overhead. Effective directional fusion yields greater gains than increasing model capacity, and CE consistently improves performance across different enhancement backbones.";

const authors = [
  "Yifei Yang",
  "Wentao Hua",
  "Jizhe Lu",
  "Leyan Yang",
  "Jun Gao",
  "Yuxiang Hu",
  "Changbao Zhu",
  "Jing Lu",
];

interface MethodDialogProps {
  panel: MethodPanel;
  onClose: () => void;
  onPanelChange: (panel: Exclude<MethodPanel, null>) => void;
}

/** 在原论文图之间提供逐层深入的方法结构浏览。 */
function MethodDialog({ panel, onClose, onPanelChange }: MethodDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (panel && !dialog.open) dialog.showModal();
    if (!panel && dialog.open) dialog.close();
  }, [panel]);

  return (
    <dialog
      ref={dialogRef}
      className="method-dialog"
      aria-labelledby="method-dialog-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="dialog-shell">
        <div className="dialog-topbar">
          <div>
            <span className="section-kicker">Method detail</span>
            <h2 id="method-dialog-title">
              {panel === "tfgca-lgm" ? "TF-GCA and LGM" : "Inside the Coarse Extractor"}
            </h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close method detail">
            <span aria-hidden="true">×</span>
          </button>
        </div>
        {panel === "coarse-extractor" ? (
          <div className="dialog-content">
            <div className="paper-figure paper-figure--detail">
              <img src="./assets/paper/figure2-coarse-extractor.png" alt="Detailed architecture of the Coarse Extractor" />
            </div>
            <button className="primary-button" type="button" onClick={() => onPanelChange("tfgca-lgm")}>
              Inspect TF-GCA and LGM
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        ) : (
          <div className="dialog-content">
            <div className="module-grid">
              <figure className="module-card" aria-label="Time-Frequency Gated Cross-Attention">
                <img src="./assets/paper/figure3-tfgca.png" alt="Architecture of Time-Frequency Gated Cross-Attention" />
              </figure>
              <figure className="module-card module-card--lgm" aria-label="Local Gated Mixer">
                <img src="./assets/paper/figure3-lgm.png" alt="Architecture of the Local Gated Mixer" />
              </figure>
            </div>
            <button className="text-button" type="button" onClick={() => onPanelChange("coarse-extractor")}>
              <span aria-hidden="true">←</span>
              Back to the Coarse Extractor
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}

/** 渲染 CORE-DSE 论文展示页及目标语音试听内容。 */
export default function App() {
  const [methodPanel, setMethodPanel] = useState<MethodPanel>(null);

  return (
    <>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="CORE-DSE home">
          <span>CORE-DSE</span>
        </a>
        <nav aria-label="Page sections">
          <a href="#abstract">Abstract</a>
          <a href="#method">Method</a>
          <a href="#audio-demo">Audio Demo</a>
        </nav>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="paper-title">
          <div className="hero-copy">
            <div className="eyebrow-row">
              <span className="eyebrow">ICASSP 2027 submission</span>
            </div>
            <h1 id="paper-title">
              <span>CORE-DSE:</span> Coarse Extraction and Refinement with Time-Frequency Gated Cross-Attention for Directional Speech Extraction
            </h1>
            <p className="authors">{authors.join(" · ")}</p>
            <div className="affiliations">
              <p><sup>1</sup> Key Laboratory of Modern Acoustics, Nanjing University, Nanjing, China</p>
              <p><sup>2</sup> NJU-Horizon Intelligent Audio Lab, Horizon Robotics, Beijing, China</p>
              <a href="mailto:lujing@nju.edu.cn">lujing@nju.edu.cn</a>
            </div>
          </div>

        </section>

        <section className="abstract-section" id="abstract" aria-labelledby="abstract-title">
          <div className="section-heading">
            <h2 id="abstract-title">Abstract</h2>
          </div>
          <div className="abstract-card">
            <p>{abstractText}</p>
            <p className="index-terms">
              <strong>Index Terms:</strong> Directional speech extraction, microphone arrays, direction of arrival, cross-attention
            </p>
          </div>
        </section>

        <section className="method-section" id="method" aria-labelledby="method-title">
          <div className="section-heading">
            <h2 id="method-title">Method overview</h2>
          </div>

          <div className="method-layout">
            <div className="overview-card">
              <div className="figure-toolbar">
                <div><span>Figure 1</span><strong>CORE-DSE overview</strong></div>
                <button className="text-button" type="button" onClick={() => setMethodPanel("coarse-extractor")}>
                  Open detail <span aria-hidden="true">↗</span>
                </button>
              </div>
              <div className="paper-figure paper-figure--overview">
                <img src="./assets/paper/figure1-overview.png" alt="Overview of the CORE-DSE framework" />
              </div>
            </div>
          </div>
        </section>

        <section className="demo-section" id="audio-demo" aria-labelledby="audio-demo-title">
          <div className="section-heading">
            <h2 id="audio-demo-title">Audio Demo</h2>
          </div>

          <AudioDemo />
        </section>
      </main>
      <MethodDialog panel={methodPanel} onClose={() => setMethodPanel(null)} onPanelChange={setMethodPanel} />
    </>
  );
}
