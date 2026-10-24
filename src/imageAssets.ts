// 依据无损图片变体清单解析资源地址，兼容本地预览及仓库子路径部署。
import imageVariants from "./image-variants.json";

const variants: Record<string, string> = imageVariants;

/** 将原始图片引用映射为更小的网页版本，已选用的地址保持基路径正确。 */
export function optimizedImageUrl(input: string): string {
  const base = import.meta.env.BASE_URL;
  const boundary = input.search(/[?#]/);
  const path = boundary < 0 ? input : input.slice(0, boundary);
  const suffix = boundary < 0 ? "" : input.slice(boundary);
  const relative = path.startsWith(base) ? path.slice(base.length) : path.replace(/^\.\//, "");
  if (!relative.startsWith("assets/")) return input;
  return `${base}${variants[relative] ?? relative}${suffix}`;
}
