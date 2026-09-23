// 构建论文首页、横向浏览的方法图和按场景切换的试听区。
import AudioDemo from "./AudioDemo";

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

const methodFigures = [
  { src: "./assets/paper/figure1-overview.png", alt: "Figure 1: CORE-DSE framework overview" },
  { src: "./assets/paper/figure2-coarse-extractor.png", alt: "Figure 2: Coarse Extractor architecture" },
  { src: "./assets/paper/figure3-tfgca.png", alt: "Figure 3: Time-Frequency Gated Cross-Attention" },
  { src: "./assets/paper/figure3-lgm.png", alt: "Figure 3: Local Gated Mixer" },
];

/** 渲染 CORE-DSE 论文展示页及目标语音试听内容。 */
export default function App() {
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

          <div className="method-carousel" role="region" aria-label="Method figures, scroll horizontally to browse" tabIndex={0}>
            {methodFigures.map((figure) => (
              <figure className="method-slide" key={figure.src}>
                <img src={figure.src} alt={figure.alt} loading="lazy" />
              </figure>
            ))}
          </div>
        </section>

        <section className="demo-section" id="audio-demo" aria-labelledby="audio-demo-title">
          <div className="section-heading">
            <h2 id="audio-demo-title">Audio Demo</h2>
          </div>

          <AudioDemo />
        </section>
      </main>

    </>
  );
}
