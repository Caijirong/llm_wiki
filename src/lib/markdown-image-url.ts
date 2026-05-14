import { normalizePath } from "@/lib/path-utils"

const URI_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\//

function isNonDriveUri(value: string): boolean {
  return URI_SCHEME_RE.test(value) && !WINDOWS_DRIVE_RE.test(value)
}

function splitUrlPrefix(value: string): { prefix: string; rest: string } {
  if (WINDOWS_DRIVE_RE.test(value)) {
    return { prefix: value.slice(0, 3), rest: value.slice(3) }
  }
  if (value.startsWith("//")) return { prefix: "//", rest: value.slice(2) }
  if (value.startsWith("/")) return { prefix: "/", rest: value.slice(1) }
  if (value.startsWith("./")) return { prefix: "./", rest: value.slice(2) }
  return { prefix: "", rest: value }
}

function decodeSegmentSafe(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function mapLocalPathSegments(
  input: string,
  mapSegment: (segment: string) => string,
): string {
  const normalized = normalizePath(input)
  if (!normalized || isNonDriveUri(normalized)) return normalized

  const { prefix, rest } = splitUrlPrefix(normalized)
  const hasTrailingSlash = rest.length > 0 && rest.endsWith("/")
  const mapped = rest
    .split("/")
    .map((segment) => (segment ? mapSegment(segment) : segment))
    .join("/")

  return hasTrailingSlash && !mapped.endsWith("/")
    ? `${prefix}${mapped}/`
    : `${prefix}${mapped}`
}

export function decodeMarkdownImageUrl(url: string): string {
  return mapLocalPathSegments(url, decodeSegmentSafe)
}

export function encodeMarkdownImageUrl(url: string): string {
  return mapLocalPathSegments(
    url,
    (segment) => encodeURIComponent(decodeSegmentSafe(segment)),
  )
}
