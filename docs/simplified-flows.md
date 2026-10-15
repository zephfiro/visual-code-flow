# Simplified PHP / Laravel presentation

This is a view-only projection over the existing Flow IR, not a less precise parser or a changed execution graph. `presentFlowGraph` returns a display graph plus a mapping from every original node ID to a visible representative. The host retains the full graph for source lookup, expansion, cache, snapshots and Mermaid export.

## Grouping rules

Linear evaluations fold into a containing expression only when source ranges, URI, expansion scope and single-entry normal-flow topology agree. A query assignment such as `$users = User::where(...)->orderBy(...)->get()` becomes one block. Its exact original calls are available in the block's source-step picker; requests to the host always use their original IDs.

Independent statements are not indiscriminately merged into a generic business-process label. Conditions, short-circuit/nullsafe branches, loops, explicit throws, unsupported constructs and finalizer completion markers are boundaries. Normal and exceptional cycles cannot be folded away. Structural, source-less merge connectors may be bypassed while retaining the incoming edge kind and label.

Unexpanded, navigation-only reference leaves can move into their owning expression's details. This does not assert their execution order. Expanded implementations remain visible via reference edges. Caught exceptions and explicit throws stay visible; only `may throw` edges to a same-scope, source-less function exit are omitted in Simplified, with a visible disclosure and count. Detailed restores the complete input graph unchanged.

## User interaction

PHP root symbols default to Simplified, including untitled buffers. Other languages retain Detailed by default. The panel remembers each language family's view preference separately; it is not a persistent workspace setting.

The toolbar counts visible versus original nodes. Selection/cursor changes highlight the containing block, and **Show N steps** exposes precise source selection. Expand/collapse and the original source selection survive detail-level changes. Labels have a bounded visual height, hover text and a source-step detail area. Analysis notes are available in both views.

**Copy detailed Mermaid** and **Save detailed .mmd** intentionally continue exporting the full graph. A simplified screenshot should not be mistaken for a complete exception-flow analysis.

## Regression fixture

The fixture containing a fluent User query, an `isEmpty` condition and two `response()->json` returns projects from 14 nodes / 22 edges to 6 nodes / 6 edges. This is a fixture result, not a promised reduction for arbitrary applications. A graph already consisting of meaningful control nodes can remain unchanged.

Tests cover source mappings, branches, early exits, loops, nullsafe/short-circuit evaluation, reference expansion, separate finally continuations, unsupported constructs, scope/file boundaries, cycles, original graph immutability and a 5,000-node projection. Tests against real PHP analysis live with the PHP adapter, while the projection itself remains independent of PHP, VS Code and React.
