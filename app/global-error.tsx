"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body><main style={{fontFamily:"Segoe UI,system-ui",minHeight:"100vh",display:"grid",placeItems:"center",background:"#f4f5f8"}}><section style={{background:"white",padding:32,borderRadius:14,maxWidth:420,textAlign:"center"}}><h1 style={{color:"#000675"}}>Lead CRM encountered a problem</h1><p>Refresh safely. If the problem continues, contact the administrator.</p><button onClick={reset} style={{background:"#e0000b",color:"white",border:0,borderRadius:8,padding:"11px 18px"}}>Retry</button></section></main></body></html>;
}
