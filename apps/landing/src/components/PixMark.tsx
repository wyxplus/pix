import logoUrl from "../assets/logo.png";
import { cn } from "../lib/utils.ts";

/** Same unpadded logo asset used by the desktop interface. */
export function PixMark(props: { className?: string; title?: string }) {
  return (
    <img
      src={logoUrl}
      width={256}
      height={256}
      alt={props.title ?? "Pix"}
      draggable={false}
      className={cn("size-7 shrink-0", props.className)}
    />
  );
}
