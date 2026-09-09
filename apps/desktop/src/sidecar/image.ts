import { readFileSync } from "node:fs";
import { PhotonImage, resize, SamplingFilter } from "@silvia-odwyer/photon-node";

/** Node image codec using the already bundled photon WASM; no desktop runtime dependency. */
export class NativeImage {
  constructor(private readonly bytes?: Uint8Array) {}
  private decode(): PhotonImage | undefined {
    try {
      return this.bytes?.length ? PhotonImage.new_from_byteslice(this.bytes) : undefined;
    } catch {
      return undefined;
    }
  }
  getSize(): { width: number; height: number } {
    const image = this.decode();
    if (!image) return { width: 0, height: 0 };
    try {
      return { width: image.get_width(), height: image.get_height() };
    } finally {
      image.free();
    }
  }
  isEmpty(): boolean {
    return this.getSize().width === 0;
  }
  toPNG(): Buffer {
    const image = this.decode();
    if (!image) return Buffer.alloc(0);
    try {
      return Buffer.from(image.get_bytes());
    } finally {
      image.free();
    }
  }
  toDataURL(): string {
    return `data:image/png;base64,${this.toPNG().toString("base64")}`;
  }
  resize(options: { width: number; height: number; quality?: string }): NativeImage {
    const image = this.decode();
    if (!image) return new NativeImage();
    try {
      const resized = resize(image, options.width, options.height, SamplingFilter.Lanczos3);
      try {
        return new NativeImage(resized.get_bytes());
      } finally {
        resized.free();
      }
    } finally {
      image.free();
    }
  }
}
export const nativeImage = {
  createFromPath(path: string): NativeImage {
    try {
      return new NativeImage(readFileSync(path));
    } catch {
      return new NativeImage();
    }
  },
};
