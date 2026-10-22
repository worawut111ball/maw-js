import { useEffect, useState } from "react";

export function useViewportInset() {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!window.visualViewport) return;
    const handler = () => {
      const vv = window.visualViewport!;
      setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    handler();
    window.visualViewport.addEventListener("resize", handler);
    window.visualViewport.addEventListener("scroll", handler);
    return () => {
      window.visualViewport?.removeEventListener("resize", handler);
      window.visualViewport?.removeEventListener("scroll", handler);
    };
  }, []);

  return inset;
}
