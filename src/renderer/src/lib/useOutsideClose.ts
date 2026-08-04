import { useEffect, useRef } from "react";

/** Close a popup when the user clicks outside of it or presses Escape. */
export function useOutsideClose(ref: React.RefObject<HTMLElement>, open: boolean, onClose: () => void) {
  const cbRef = useRef(onClose);
  cbRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cbRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cbRef.current();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref]);
}
