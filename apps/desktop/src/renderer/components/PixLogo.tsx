import logoUrl from "../assets/logo.png";
import { cn } from "../lib/utils.ts";

/** Unpadded export of the application icon in build/icon.png. */
export function PixLogo(props: { className?: string; title?: string }) {
  return (
    <img
      src={logoUrl}
      width={256}
      height={256}
      alt={props.title ?? "Pix"}
      draggable={false}
      className={cn("size-5 shrink-0", props.className)}
    />
  );
}
