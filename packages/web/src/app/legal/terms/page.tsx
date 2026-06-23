import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const metadata = {
  title: "Terms of Service",
};

async function getTerms(): Promise<string> {
  // Read TERMS.md from repo root. In production (Next.js standalone output),
  // the file is traced via outputFileTracing.
  const root = join(process.cwd(), "..", "..");
  try {
    return await readFile(join(root, "TERMS.md"), "utf-8");
  } catch {
    return "# Terms of Service\n\nTerms document not found. Contact the site administrator.";
  }
}

export default async function TermsPage() {
  const terms = await getTerms();
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <article className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap font-mono text-sm leading-relaxed text-[var(--color-text-primary)]">
        {terms}
      </article>
    </div>
  );
}
