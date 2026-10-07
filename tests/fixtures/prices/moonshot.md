# Model Inference Pricing Explanation

export const DocTable = ({columns = [], rows = []}) => {
  return <div className="doc-table-wrap">…</div>;
};

## Model Pricing

### K3 Series Models

<DocTable
  columns={[
{ title: "Model", width: "12%" },
{ title: "Unit", width: "10%" },
{ title: "Cache Write Price (TTL 5min)", width: "13%" },
{ title: "Cache Write Price (TTL 1h)", width: "13%" },
{ title: "Cached Input Price", width: "13%" },
{ title: "Input Price", width: "13%" },
{ title: "Output Price", width: "10%" },
{ title: "Context Window", width: "16%" },
]}
  rows={[
["kimi-k3", "1M tokens", <>{"$"}3.00</>, <>{"$"}6.00</>, <>{"$"}0.30</>, <>{"$"}3.00</>, <>{"$"}15.00</>, "1,048,576 tokens"],
]}
/>

Note: **Cache Write** refers to the cost of writing request prefixes into the [context cache](/docs/guide/context-caching). The Kimi API automatically caches repeated request prefixes, and cache entries come in two time-to-live (TTL) tiers — 5min and 1h. If no TTL is specified, the 5min tier applies by default. Input that hits the cache within its lifetime is billed only at the Cached Input Price: each hit automatically refreshes the cache entry's lifetime, with no additional cache write charge.

### K2 Series Models

<DocTable
  columns={[
{ title: "Model", width: "24%" },
{ title: "Unit", width: "12%" },
{ title: "Input Price (Cache Hit)", width: "16%" },
{ title: "Input Price (Cache Miss)", width: "16%" },
{ title: "Output Price", width: "14%" },
{ title: "Context Window", width: "18%" },
]}
  rows={[
["kimi-k2.7-code", "1M tokens", <>{"$"}0.19</>, <>{"$"}0.95</>, <>{"$"}4.00</>, "262,144 tokens"],
["kimi-k2.7-code-highspeed", "1M tokens", <>{"$"}0.38</>, <>{"$"}1.90</>, <>{"$"}8.00</>, "262,144 tokens"],
["kimi-k2.6", "1M tokens", <>{"$"}0.16</>, <>{"$"}0.95</>, <>{"$"}4.00</>, "262,144 tokens"],
]}
/>

Here, 1M = 1,000,000. The prices in the table represent the cost per 1M tokens consumed.
