/**
 * Document paths for the edges of one node (omnist-spec E-10, Sec8.4).
 *
 * The index `[i]` -- the 0-based position among the node's edges that share
 * the label -- is on EVERY edge of a label that occurs more than once in the
 * node, the first included (`$.item[0]`, `$.item[1]`), and absent when the
 * label occurs exactly once (`$.item`). The count is of the edges the node
 * holds, not of any cardinality a schema declares, and is taken per node.
 * Every place that names a Document path (the Doc cursor, validate,
 * materialize, the writers' reports and errors) builds it here, so the rule
 * lives in one function.
 */

/** An edge, structurally: only the label matters to a path. */
interface Labeled {
  readonly label: string;
}

/** The Document path of each edge of the node at `path`, in edge order. */
export function edgePaths(path: string, edges: readonly Labeled[]): string[] {
  const n = edges.length;
  const out = new Array<string>(n);
  if (n === 1) {
    // A lone edge cannot share its label with another: no counting needed.
    out[0] = path + "." + (edges[0] as Labeled).label;
    return out;
  }
  const totals = new Map<string, number>();
  for (const { label } of edges) totals.set(label, (totals.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const label = (edges[i] as Labeled).label;
    if (totals.get(label) === 1) {
      out[i] = path + "." + label;
    } else {
      const k = seen.get(label) ?? 0;
      seen.set(label, k + 1);
      out[i] = path + "." + label + "[" + String(k) + "]";
    }
  }
  return out;
}
