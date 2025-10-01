// app/page.tsx
export const dynamic = 'force-dynamic';  // pastikan tidak ke-cache

export default function Page() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0,7) ?? 'local';
  const url    = process.env.VERCEL_URL ?? 'localhost';

  return (
    <main style={{padding: 24, fontFamily: 'system-ui'}}>
      <h1 style={{margin: 0}}>Tapeflow Monitoring</h1>
      <p data-proof="rendered-by-app-page">
        BUILD OK — rendered by <code>app/page.tsx</code>
      </p>
      <small>build: {commit} • {url}</small>
    </main>
  );
}
