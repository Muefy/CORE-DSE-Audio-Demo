// 网页试听资源调度：会话内复用 Blob，前台优先、后台两路分阶段下载。
// 快速切换时降级或取消旧任务，缓冲音频时让出带宽，不预取内部分析图片。

type MediaKind = "image" | "audio";
type DownloadTask = {
  url: string;
  kind: MediaKind;
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (error: Error) => void;
  listeners: number;
  backgroundPriority?: number;
  controller?: AbortController;
  restart: boolean;
  timedOut: boolean;
  reload: boolean;
};

/** 管理有限并发的媒体下载和当前页面会话缓存。 */
export class MediaCache {
  private readonly ready = new Map<string, string>();
  private readonly failed = new Map<string, Error>();
  private readonly tasks = new Map<string, DownloadTask>();
  private readonly running = new Set<DownloadTask>();
  private readonly buffering = new Set<string>();
  private sequence = "";
  private stopped = false;
  private readonly concurrency: number;
  private readonly timeoutMs: number;

  /** 设置同时下载数量与单次请求超时，默认值适合静态媒体页面。 */
  constructor(concurrency = 2, timeoutMs = 20000) {
    this.concurrency = concurrency;
    this.timeoutMs = timeoutMs;
  }

  /** 获取已完整下载的稳定 Blob 地址，不改变现有播放器音源。 */
  cachedUrl(url: string): string | undefined {
    return this.ready.get(url);
  }

  /** 用户重试无效媒体时释放该项缓存，其他已加载资源不受影响。 */
  invalidate(url: string): void {
    const cached = this.ready.get(url);
    if (cached) URL.revokeObjectURL(cached);
    this.ready.delete(url);
    this.failed.delete(url);
  }

  /** 取得或建立单一 URL 任务，失败结果只有明确重试才重新请求。 */
  private taskFor(url: string, kind: MediaKind, retry: boolean): DownloadTask {
    if (retry) this.failed.delete(url);
    const existing = this.tasks.get(url);
    if (existing) return existing;
    let resolve!: (value: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((success, failure) => { resolve = success; reject = failure; });
    const task: DownloadTask = { url, kind, promise, resolve, reject, listeners: 0, restart: false, timedOut: false, reload: retry };
    this.tasks.set(url, task);
    return task;
  }

  /** 注册可见图片的前台需求；组件离开后及时释放优先权。 */
  acquire(url: string, kind: MediaKind, retry = false): { promise: Promise<string>; release: () => void } {
    const cached = this.ready.get(url);
    if (cached) return { promise: Promise.resolve(cached), release: () => undefined };
    if (!retry && this.failed.has(url)) return { promise: Promise.reject(this.failed.get(url)), release: () => undefined };
    const task = this.taskFor(url, kind, retry);
    task.listeners += 1;
    this.pump();
    let released = false;
    return {
      promise: task.promise,
      release: () => {
        if (released) return;
        released = true;
        task.listeners = Math.max(0, task.listeners - 1);
        if (!task.listeners && task.backgroundPriority === undefined && this.tasks.get(url) === task) {
          this.tasks.delete(url);
          task.controller?.abort();
          task.reject(new DOMException("Media request is no longer needed.", "AbortError"));
        }
        this.pump();
      },
    };
  }

  /** 排入不阻塞界面的后台任务，同一 URL 与前台请求共享下载。 */
  private prefetch(url: string, kind: MediaKind, priority: number): Promise<string> {
    const cached = this.ready.get(url);
    if (cached) return Promise.resolve(cached);
    if (this.failed.has(url)) return Promise.reject(this.failed.get(url));
    const task = this.taskFor(url, kind, false);
    task.backgroundPriority = Math.min(task.backgroundPriority ?? priority, priority);
    this.pump();
    return task.promise;
  }

  /** 音频等待可播放数据时暂停后台下载，前台图片仍可正常工作。 */
  setBuffering(key: string, waiting: boolean): void {
    if (waiting) this.buffering.add(key);
    else this.buffering.delete(key);
    this.pump();
  }

  /** 在浏览器空闲或短暂让出主线程后继续下个预取阶段。 */
  private idle(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window !== "undefined" && "requestIdleCallback" in window) window.requestIdleCallback(() => resolve(), { timeout: 1200 });
      else setTimeout(resolve, 80);
    });
  }

  /** 按默认图片、其他场景图片、全部音频顺序执行一次会话预取。 */
  startPreload(defaultImages: string[], otherImages: string[], audio: string[]): void {
    const sequence = JSON.stringify([defaultImages, otherImages, audio]);
    if (this.sequence === sequence || this.stopped) return;
    this.sequence = sequence;
    void (async () => {
      await Promise.allSettled(defaultImages.map((url) => this.prefetch(url, "image", 1)));
      await this.idle();
      if (this.stopped || this.sequence !== sequence) return;
      await Promise.allSettled(otherImages.map((url) => this.prefetch(url, "image", 2)));
      await this.idle();
      if (this.stopped || this.sequence !== sequence) return;
      await Promise.allSettled(audio.map((url) => this.prefetch(url, "audio", 3)));
    })();
  }

  /** 以使用者需求为最高优先级，必要时让低优先级任务暂停重排。 */
  private pump(): void {
    if (this.stopped) return;
    const priority = (task: DownloadTask) => task.listeners ? 0 : task.backgroundPriority ?? 9;
    const queued = Array.from(this.tasks.values()).filter((task) => !task.controller && (task.listeners || !this.buffering.size));
    queued.sort((left, right) => priority(left) - priority(right));
    for (const task of this.running) {
      if (!task.listeners && (this.buffering.size || (queued[0] && priority(queued[0]) < priority(task)))) {
        task.restart = true;
        task.controller?.abort();
      }
    }
    while (this.running.size < this.concurrency && queued.length) {
      const task = queued.shift()!;
      if (this.tasks.get(task.url) !== task) continue;
      this.running.add(task);
      task.controller = new AbortController();
      task.restart = false;
      task.timedOut = false;
      void this.download(task);
    }
  }

  /** 下载压缩媒体并缓存 Blob；超时和真实错误不会阻塞下一项。 */
  private async download(task: DownloadTask): Promise<void> {
    const timer = setTimeout(() => { task.timedOut = true; task.controller?.abort(); }, this.timeoutMs);
    try {
      const response = await fetch(task.url, { signal: task.controller!.signal, cache: task.reload ? "reload" : "default", priority: task.listeners ? "high" : "low" });
      if (!response.ok) throw new Error(`Media could not be loaded (${response.status}).`);
      const blob = await response.blob();
      if (task.controller!.signal.aborted || this.tasks.get(task.url) !== task) return;
      if (!blob.size) throw new Error("The media file is empty.");
      const url = URL.createObjectURL(blob);
      this.ready.set(task.url, url);
      this.tasks.delete(task.url);
      task.resolve(url);
    } catch (failure: unknown) {
      if (!task.restart && this.tasks.get(task.url) === task) {
        const error = task.timedOut ? new Error("Media loading timed out. Please retry.") : failure instanceof Error ? failure : new Error("Media is unavailable.");
        this.failed.set(task.url, error);
        this.tasks.delete(task.url);
        task.reject(error);
      }
    } finally {
      clearTimeout(timer);
      this.running.delete(task);
      task.controller = undefined;
      this.pump();
    }
  }

  /** 页面真正离开时释放 Blob 与未完成请求，不影响往返缓存。 */
  dispose(): void {
    this.stopped = true;
    for (const task of this.tasks.values()) {
      task.controller?.abort();
      task.reject(new DOMException("Page was closed.", "AbortError"));
    }
    this.tasks.clear();
    for (const url of this.ready.values()) URL.revokeObjectURL(url);
    this.ready.clear();
  }
}

export const mediaCache = new MediaCache();
if (typeof window !== "undefined") window.addEventListener("pagehide", (event) => { if (!event.persisted) mediaCache.dispose(); });
