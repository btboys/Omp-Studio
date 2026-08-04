import type { PiApi } from "./index";

declare global {
  interface Window {
    pi: PiApi;
  }
}

export {};
