import { defaultUrlTransform } from "react-markdown"
import type { UrlTransform } from "react-markdown"

const WINDOWS_DRIVE_IMAGE_RE = /^[A-Za-z]:[\\/]/

export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  const safeUrl = defaultUrlTransform(url)
  if (safeUrl || !url) return safeUrl

  if (
    key === "src" &&
    node.tagName === "img" &&
    WINDOWS_DRIVE_IMAGE_RE.test(url)
  ) {
    return url
  }

  return safeUrl
}
