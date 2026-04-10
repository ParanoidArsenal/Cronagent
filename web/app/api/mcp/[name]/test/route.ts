import { getMcpServer } from '@/lib/backend';
import { execa } from 'execa';
import { join } from 'path';

// Next.js standalone runs from /app/web; project root is one level up
const PROJECT_ROOT = join(process.cwd(), '..');

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const decodedName = decodeURIComponent(name);

  try {
    const server = await getMcpServer(decodedName);
    if (!server) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // Spawn the MCP server process from project root so relative paths resolve correctly
    const proc = execa(server.command, server.args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      timeout: 5000,
      reject: false,
      stdin: 'pipe',
    });

    // MCP servers are long-running stdio processes — they won't exit on their own.
    // Wait briefly, then kill. If the process is still alive after 2s, it started OK.
    const result = await new Promise<{ ok: boolean; stderr?: string }>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve({ ok: true }); // Process stayed alive = good
      }, 2000);

      proc.then((r) => {
        clearTimeout(timer);
        // Process exited before our timer — check if it crashed
        resolve({
          ok: r.exitCode === 0,
          stderr: r.stderr ? String(r.stderr).slice(0, 500) : undefined,
        });
      });
    });

    if (!result.ok) {
      return Response.json({ ok: false, name: decodedName, error: result.stderr }, { status: 502 });
    }
    return Response.json({ ok: true, name: decodedName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 502 });
  }
}
