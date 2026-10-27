// 展示单个实录场景的混合观测、三位说话人的四路对照与中文标注。
// 两组增强输出分别来自 without CE 和 with CE 目录，仅显示 P808_MOS。
// 清单独立加载并可重试，图片和原生播放器复用主试听区的缓存与播放逻辑。
// 外层折叠容器负责标题、锚点和首次挂载，本组件保留实录展示内容。
// 混合观测前说明实录条件、仿真训练设置及三种参考音轨的构造方式。
import type { ReactNode } from "react";
import { optimizedImageUrl } from "./imageAssets";

interface RealMedia {
  audio: string;
  spectrogram: string;
  metrics?: { P808_MOS: number };
}

interface RealSpeaker {
  id: string;
  index: number;
  azimuthDeg: number;
  elevationDeg: number;
  distanceM: number;
  transcript: string;
  nearField: RealMedia;
  farField: RealMedia;
  withoutCe: RealMedia;
  withCe: RealMedia;
}

export interface RealRecording {
  id: "real1";
  durationS: number;
  sampleRateHz: number;
  mixture: RealMedia;
  speakers: RealSpeaker[];
}

export interface RealTrack {
  key: string;
  label: string;
  accessibilityLabel: string;
  kind: "unprocessed" | "clean" | "enhanced";
  audio: string;
  spectrogram: string;
  durationS: number;
  p808Mos?: number;
}

interface RealRecordingsProps {
  recording?: RealRecording;
  error?: string;
  onRetry: () => void;
  renderTrack: (track: RealTrack) => ReactNode;
}

let recordingCache: RealRecording | undefined;
let recordingRequest: Promise<RealRecording> | undefined;

/** 拼接实录资产路径，兼容本地预览和仓库子路径部署。 */
function realAssetUrl(relativePath: string): string {
  return `${import.meta.env.BASE_URL}assets/scenes/real1/${relativePath}`;
}

/** 校验三位说话人的顺序、十五秒时长与完整资源，避免误配参考语音。 */
function parseRecording(raw: unknown): RealRecording {
  const recording = raw as RealRecording;
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const media = (value: RealMedia | undefined) => [value?.audio, value?.spectrogram].every((path) =>
    typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("..") && !path.includes(":") && !path.includes("\\")
  );
  if (
    recording?.id !== "real1" || recording.durationS !== 15 || recording.sampleRateHz !== 16000 ||
    !media(recording.mixture) || !Array.isArray(recording.speakers) || recording.speakers.length !== 3 ||
    recording.speakers.some((speaker, index) =>
      speaker.id !== `ID${index + 1}` || speaker.index !== index + 1 ||
      !finite(speaker.azimuthDeg) || !finite(speaker.elevationDeg) || !finite(speaker.distanceM) ||
      typeof speaker.transcript !== "string" || !speaker.transcript.trim() ||
      !media(speaker.nearField) || !media(speaker.farField) ||
      !media(speaker.withoutCe) || !media(speaker.withCe) ||
      !finite(speaker.withoutCe.metrics?.P808_MOS) || !finite(speaker.withCe.metrics?.P808_MOS)
    )
  ) throw new Error("Real recording metadata is incomplete or the speaker order is invalid.");
  return recording;
}

/** 缓存实录清单和正在进行的请求，失败时允许明确重新读取。 */
export function loadRealRecording(retry = false): Promise<RealRecording> {
  if (retry) recordingCache = undefined;
  if (recordingCache) return Promise.resolve(recordingCache);
  if (recordingRequest) return recordingRequest;
  recordingRequest = fetch(realAssetUrl("manifest.json"), { signal: AbortSignal.timeout(15000), cache: retry ? "reload" : "default" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Real recording metadata could not be loaded (${response.status}).`);
      const recording = parseRecording(await response.json());
      recordingCache = recording;
      return recording;
    })
    .finally(() => { recordingRequest = undefined; });
  return recordingRequest;
}

/** 只向统一调度器注册十三条展示音轨及对应图片，不读取六通道源音频。 */
export function realRecordingMedia(recording: RealRecording): { images: string[]; audio: string[] } {
  const media = [recording.mixture, ...recording.speakers.flatMap((speaker) => [speaker.nearField, speaker.farField, speaker.withoutCe, speaker.withCe])];
  return {
    images: media.map((entry) => optimizedImageUrl(realAssetUrl(entry.spectrogram))),
    audio: media.map((entry) => realAssetUrl(entry.audio)),
  };
}

/** 构建具有独立进度和明确说话人标签的十五秒实录音轨。 */
function realTrack(recording: RealRecording, media: RealMedia, key: string, label: string, kind: RealTrack["kind"], speaker?: RealSpeaker): RealTrack {
  return {
    key: `real1:${key}`,
    label,
    accessibilityLabel: speaker ? `Speaker ${speaker.index} ${label}` : `Real recording ${label}`,
    kind,
    audio: realAssetUrl(media.audio),
    spectrogram: optimizedImageUrl(realAssetUrl(media.spectrogram)),
    durationS: recording.durationS,
    p808Mos: media.metrics?.P808_MOS,
  };
}

/** 以居中混合卡和逐说话人两行四卡展示实录，不引入额外播放状态。 */
export default function RealRecordings({ recording, error, onRetry, renderTrack }: RealRecordingsProps) {
  return (
    <div className="real-recording-content">
      <div className="real-recording-description">
        <p>This challenging real-world recording features <strong>three simultaneous speakers in a large classroom</strong>, two of whom are located approximately 5 m from the microphone array. <strong>All models were trained on the simulated datasets</strong> described in the paper, without fine-tuning on real recordings, to evaluate their generalization to real-world acoustic conditions.</p>
        <dl>
          <div><dt>Unprocessed</dt><dd>The recording uses the same microphone array configuration as that used in the simulations described in the paper. The signal from the reference microphone (channel 0) is presented.</dd></div>
          <div><dt>Close-talking Speech</dt><dd>Each speaker was recorded using a close-talking microphone, and the recordings were enhanced using TF-GridNet.</dd></div>
          <div><dt>Far-field Reference (50 ms)</dt><dd>The close-talking speech is projected onto the far-field reference microphone (channel 0) using an FIR filter truncated to 50 ms. <strong>The resulting signal serves as the target for the models to recover.</strong></dd></div>
        </dl>
        <p className="real-recording-status">Data collection is ongoing, and further details will be presented in our future work.</p>
      </div>
      {error ? (
        <div className="scene-message scene-message--error" role="alert"><p>{error}</p><button type="button" className="metric-toggle" onClick={onRetry}>Retry recording</button></div>
      ) : !recording ? (
        <p className="scene-message" role="status">Loading real recording…</p>
      ) : (
        <>
          <div className="real-mixture-grid">
            {renderTrack(realTrack(recording, recording.mixture, "unprocessed", "Unprocessed", "unprocessed"))}
          </div>
          {recording.speakers.map((speaker) => (
            <section className="real-speaker" key={speaker.id} data-speaker-id={speaker.id} aria-labelledby={`real-speaker-${speaker.index}`}>
              <h4 id={`real-speaker-${speaker.index}`}>Speaker {speaker.index}</h4>
              <dl className="acoustic-grid real-position" aria-label={`Speaker ${speaker.index} position`}>
                <div>
                  <dt>Target Position</dt>
                  <dd>
                    <span className="position-coordinate">Azimuth {speaker.azimuthDeg.toFixed(1)}°</span>{" · "}
                    <span className="position-coordinate">Elevation {speaker.elevationDeg.toFixed(1)}°</span>{" · "}
                    <span className={`position-coordinate${speaker.index < 3 ? " real-distance" : ""}`}>Distance {speaker.distanceM.toFixed(2)} m</span>
                  </dd>
                </div>
              </dl>
              <div className="real-speaker-grid">
                {renderTrack(realTrack(recording, speaker.nearField, `${speaker.id}:near-field`, "Close-talking Speech", "clean", speaker))}
                {renderTrack(realTrack(recording, speaker.farField, `${speaker.id}:far-field`, "Far-field Reference (50 ms)", "clean", speaker))}
                {renderTrack(realTrack(recording, speaker.withoutCe, `${speaker.id}:without-ce`, "SpatialNet-Concat (without CE)", "enhanced", speaker))}
                {renderTrack(realTrack(recording, speaker.withCe, `${speaker.id}:with-ce`, "SpatialNet-CORE (with CE)", "enhanced", speaker))}
              </div>
              <div className="real-transcript" aria-label={`Speaker ${speaker.index} transcript`}>
                <span>Transcript</span>
                <p lang="zh-CN">{speaker.transcript}</p>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
