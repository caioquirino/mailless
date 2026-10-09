import type { JmapClient } from '@mailless/jmap-client';
import type { Attachment } from './mail';

/*
 * What is attached to a message is somebody else's content. It is never
 * made part of this page. The kinds that can do nothing but be looked at
 * are opened in a tab of their own; anything else, which includes every
 * kind that could carry a script (a web page, a drawing in SVG), is only
 * ever saved to disk.
 */

/** The kinds a browser shows without running anything in them. */
const VIEWABLE =
  /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/i;

export function canView(attachment: Attachment): boolean {
  return VIEWABLE.test(attachment.type.split(';')[0]?.trim() ?? '');
}

async function blobUrl(
  client: JmapClient,
  attachment: Attachment,
  type: string,
): Promise<string> {
  const bytes = await client.download(attachment.blobId, {
    name: attachment.name,
    type: attachment.type,
  });
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  // Long enough to be opened or saved; then the browser may let go of it.
  window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
  return url;
}

/** Saves an attachment to disk. */
export async function saveAttachment(
  client: JmapClient,
  attachment: Attachment,
): Promise<void> {
  // As plain bytes, so that nothing tries to show it.
  const url = await blobUrl(client, attachment, 'application/octet-stream');
  const link = document.createElement('a');
  link.href = url;
  link.download = attachment.name;
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Opens an attachment in a tab of its own when it is of a kind that can
 * only be looked at, and saves it otherwise. To be called because something
 * was pressed: a browser opens a tab for nothing else.
 */
export async function openAttachment(
  client: JmapClient,
  attachment: Attachment,
): Promise<void> {
  if (!canView(attachment)) return saveAttachment(client, attachment);
  // Opened now, while the browser still knows a person asked; filled in when the file has arrived.
  const tab = window.open('about:blank', '_blank');
  if (!tab) return saveAttachment(client, attachment);
  try {
    // The tab is told nothing of the page it was opened from.
    tab.opener = null;
    const type = attachment.type.split(';')[0]?.trim().toLowerCase() as string;
    tab.location.replace(await blobUrl(client, attachment, type));
  } catch (error) {
    tab.close();
    throw error;
  }
}
