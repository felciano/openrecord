/**
 * Download a single imaging study and encode its images as JPEGs.
 *
 * Shared by the `download_imaging_study` MCP tool. Kept separate from tool
 * registration so it can be unit-tested against fake-mychart without standing
 * up an MCP server. Uses the pure-JS CLO→JPEG path (convertCloToBitmap16 +
 * jpeg-js) so the MCPB ships no native image dependency.
 */
import type { MyChartRequest } from '../../../scrapers/myChart/myChartRequest';
import type { FdiContext } from '../../../scrapers/myChart/eunity/imagingViewer';
import { downloadImagingStudyDirect } from '../../../scrapers/myChart/eunity/imagingDirectDownload';
import { convertCloToBitmap16 } from '../../../scrapers/myChart/clo-image-parser/clo_to_bitmap';
import { encodeCloAsJpeg } from './jpeg-encoder';

export interface StudyJpeg {
  index: number;
  seriesDescription: string;
  width: number;
  height: number;
  bytes: number;
  /** Base64-encoded JPEG bytes, ready to drop into an MCP image content block. */
  jpegBase64: string;
}

export interface DownloadStudyJpegsResult {
  studyName: string;
  /** Total image instances the study contains. */
  totalImages: number;
  /** How many images were encoded and returned (capped by maxImages). */
  returned: number;
  images: StudyJpeg[];
  /** Non-fatal errors from the download/encode pipeline. */
  errors: string[];
}

/**
 * Pack an FdiContext into a single opaque `image_id` token (base64url of the
 * JSON). One copy-paste value is easier for the model to round-trip from
 * get_imaging_results into download_imaging_study than two separate fields,
 * and base64url avoids delimiter collisions — `fdi`/`ord` are arbitrary
 * URL-encoded tokens that could contain a colon, comma, etc.
 */
export function encodeImageId(fdiContext: FdiContext): string {
  return Buffer.from(JSON.stringify({ fdi: fdiContext.fdi, ord: fdiContext.ord }), 'utf8').toString('base64url');
}

/** Inverse of encodeImageId. Throws if the token is malformed. */
export function decodeImageId(imageId: string): FdiContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(imageId, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid image_id — expected the image_id value from a get_imaging_results entry.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as FdiContext).fdi !== 'string' ||
    typeof (parsed as FdiContext).ord !== 'string'
  ) {
    throw new Error('Invalid image_id — expected the image_id value from a get_imaging_results entry.');
  }
  return { fdi: (parsed as FdiContext).fdi, ord: (parsed as FdiContext).ord };
}

export interface DownloadStudyJpegsOptions {
  studyName?: string;
  /** Max images to download and encode (default 3). */
  maxImages?: number;
  /** JPEG quality 1-100 (default 85). */
  jpegQuality?: number;
}

/**
 * Resolve a fresh image-viewer session from `fdiContext`, download the study's
 * CLO image data over HTTP, and encode the first `maxImages` images as JPEGs.
 *
 * `fdiContext` ({ fdi, ord }) comes from an entry returned by
 * `getImagingResults` — it is durable report-identifier data, so a fresh
 * single-use SAML viewer URL is fetched internally on every call.
 */
export async function downloadStudyJpegs(
  req: MyChartRequest,
  fdiContext: FdiContext,
  opts: DownloadStudyJpegsOptions = {},
): Promise<DownloadStudyJpegsResult> {
  const studyName = opts.studyName ?? 'imaging study';
  const maxImages = opts.maxImages ?? 3;
  const jpegQuality = opts.jpegQuality ?? 85;

  // `outputDir` is unused because skipFileWrite keeps everything in memory —
  // the MCPB never writes image files to the user's disk.
  const downloaded = await downloadImagingStudyDirect(req, fdiContext, studyName, '', {
    skipFileWrite: true,
    maxImages,
  });

  const errors = [...downloaded.errors];
  const withPixels = downloaded.images.filter((img) => img.pixelData && img.pixelData.length > 0);
  const images: StudyJpeg[] = [];

  for (let i = 0; i < Math.min(withPixels.length, maxImages); i++) {
    const img = withPixels[i];
    try {
      const bitmap = convertCloToBitmap16(img.pixelData!, img.wrapperData);
      const encoded = encodeCloAsJpeg(bitmap, jpegQuality);
      images.push({
        index: i,
        seriesDescription: img.seriesDescription,
        width: encoded.width,
        height: encoded.height,
        bytes: encoded.bytes,
        jpegBase64: Buffer.from(encoded.buffer).toString('base64'),
      });
    } catch (err) {
      errors.push(`Failed to encode image ${i} (${img.seriesDescription}): ${(err as Error).message}`);
    }
  }

  return {
    studyName: downloaded.studyName || studyName,
    totalImages: downloaded.images.length,
    returned: images.length,
    images,
    errors,
  };
}
