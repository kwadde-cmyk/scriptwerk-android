/** Download prefix. An empty policy name keeps the scriptwerk- names. */
export function exportBase(policyName: string): string {
  const slug = policyName
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return slug || "scriptwerk";
}
