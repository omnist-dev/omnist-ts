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
 * lives in one place.
 *
 * Cost: paths are built for every edge of every node a writer or validator
 * visits, so the common case must be cheap. {@link EdgePaths} first finds
 * which labels repeat (usually none, found without allocating anything for a
 * small node); a label that does not repeat gets `path.label` and nothing
 * else, and only a repeated label pays for an index counter.
 */

/** An edge, structurally: only the label matters to a path. */
interface Labeled {
  readonly label: string;
}

/** Nodes of at most this many edges are checked for a repeat without a Set. */
const SMALL = 8;

/** The labels that occur more than once among `edges`, or `undefined` if none. */
function repeatedLabels(edges: readonly Labeled[]): Set<string> | undefined {
  const n = edges.length;
  if (n < 2) return undefined;
  if (n <= SMALL) {
    // Quadratic but allocation-free: for a handful of edges it beats a Set.
    let any = false;
    for (let i = 1; i < n && !any; i++) {
      const label = (edges[i] as Labeled).label;
      for (let j = 0; j < i; j++) {
        if ((edges[j] as Labeled).label === label) {
          any = true;
          break;
        }
      }
    }
    if (!any) return undefined;
  }
  const seen = new Set<string>();
  let repeated: Set<string> | undefined;
  for (const { label } of edges) {
    if (seen.has(label)) (repeated ??= new Set<string>()).add(label);
    else seen.add(label);
  }
  return repeated;
}

/**
 * The paths of one node's edges, produced in edge order: call {@link next}
 * once per edge, with that edge's label.
 */
export class EdgePaths {
  private readonly path: string;
  private readonly repeated: Set<string> | undefined;
  private seen: Map<string, number> | undefined;

  constructor(path: string, edges: readonly Labeled[]) {
    this.path = path;
    this.repeated = repeatedLabels(edges);
  }

  /** The Document path of the next edge, whose label is `label`. */
  next(label: string): string {
    if (this.repeated === undefined || !this.repeated.has(label)) return this.path + "." + label;
    const seen = (this.seen ??= new Map<string, number>());
    const k = seen.get(label) ?? 0;
    seen.set(label, k + 1);
    return this.path + "." + label + "[" + String(k) + "]";
  }
}

/** The Document path of each edge of the node at `path`, in edge order. */
export function edgePaths(path: string, edges: readonly Labeled[]): string[] {
  const ep = new EdgePaths(path, edges);
  return edges.map((e) => ep.next(e.label));
}
