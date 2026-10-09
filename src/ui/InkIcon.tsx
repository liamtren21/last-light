export function InkIcon({kind}:{kind:'journal'|'menu'}){
  return <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="square" strokeLinejoin="round">{kind==='menu'?<path d="M3 6L29 5.7M3.5 16L28.5 16.4M3 26L29 25.7"/>:<><path d="M6 3.5L26 4 25.5 28 6 28.5Z M10 4L10.3 28"/><path d="M14 10L22 10.4M14 15.5L22 15M14 21L20 21.3"/></>}</svg>;
}
