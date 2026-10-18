import { useEffect, useRef, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';

/** Resolve ink from the host's actual text color, including custom DSH themes. */
export function VoiceOrb({ state, paused = false, speed = 1 }) {
  const container = useRef(null);
  const [theme, setTheme] = useState('auto');
  useEffect(() => {
    const update = () => {
      const color = getComputedStyle(container.current).color;
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (channels?.length === 3) setTheme(channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 > 140 ? 'dark' : 'light');
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] });
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', update);
    return () => { observer.disconnect(); scheme.removeEventListener('change', update); };
  }, []);
  return <span ref={container} className="dsh-voicebox-orb" aria-hidden="true">
    <ThinkingOrb state={state} size={64} theme={theme} paused={paused} speed={speed} aria-hidden="true" style={{ width: 40, height: 40 }} />
  </span>;
}
