import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const metadata = {
  title: "Privacy Policy",
};

async function getPrivacy(): Promise<string> {
  const root = join(process.cwd(), "..", "..");
  try {
    return await readFile(join(root, "PRIVACY.md"), "utf-8");
  } catch {
    return "# Privacy Policy\n\nPrivacy document not found. Contact the site administrator.";
  }
}

export default async function PrivacyPage() {
  const privacy = await getPrivacy();
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <article className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap font-mono text-sm leading-relaxed text-[var(--color-text-primary)]">
        {privacy}
      </article>
    </div>
  );
}
