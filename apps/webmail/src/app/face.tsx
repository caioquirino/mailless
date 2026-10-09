import { Avatar } from '@mailless/ui';
import { useMail, useSynced } from './services';

export interface FaceProps {
  /** What they are called, for the initial that stands in for a picture. */
  name: string;
  /** Their address, by which their picture is found. */
  email?: string | undefined;
  size?: 'small' | 'large';
}

/**
 * Who someone is, at a glance: the picture kept of them in the address book,
 * or their initial on a colour of their own. The picture is nobody's but the
 * user's: it is the one they put on that person's card, and nothing is asked
 * of anyone else to show it.
 */
export function Face({ name, email, size }: FaceProps) {
  const { store } = useMail();
  useSynced(store.contacts.cards);
  useSynced(store.contacts.photos);
  const card = email ? store.contacts.cardFor(email) : undefined;
  const blobId =
    Object.values(card?.media ?? {}).find(
      (each) => each.kind === 'photo' && each.blobId,
    )?.blobId ?? null;
  const url = blobId ? store.contacts.photos.url(blobId) : undefined;
  if (!url) return <Avatar name={name} size={size} />;
  return (
    <img
      className={`avatar avatar-photo${size ? ` avatar-${size}` : ''}`}
      src={url}
      alt=""
    />
  );
}
