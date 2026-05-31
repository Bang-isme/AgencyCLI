import { getDb, closeAllDbs } from "../db.js";
import { VectorStore } from "../vector-store.js";

function runBenchmark() {
  console.log("=========================================");
  console.log("Starting @agency/memory Retrieval Benchmarks");
  console.log("=========================================");

  const backend = getDb(":memory:", ":memory:");
  const store = new VectorStore(backend);

  const dim = 1536;
  const count = 1000;
  
  console.log(`Ingesting ${count} vectors of dimension ${dim}...`);
  
  const startIngest = Date.now();
  for (let i = 0; i < count; i++) {
    const vector = new Array(dim).fill(0).map(() => Math.random());
    store.insert({
      id: `symbol-${i}`,
      tenant_id: "default",
      memory_type: "semantic",
      state: "ACTIVE",
      vector,
      content: `Code chunk content ${i}`,
      metadata: { index: i },
      lamport_timestamp: 0,
    });
  }
  const endIngest = Date.now();
  console.log(`Ingestion completed in ${endIngest - startIngest}ms (avg ${(endIngest - startIngest) / count}ms/vector).`);

  // Run searches to measure recall and latency scaling
  const queryVector = new Array(dim).fill(0).map(() => Math.random());
  
  console.log(`Executing similarity search queries...`);
  
  const warmUpCount = 10;
  for (let i = 0; i < warmUpCount; i++) {
    store.search(queryVector, { limit: 10 });
  }

  const searchCount = 50;
  const startSearch = Date.now();
  for (let i = 0; i < searchCount; i++) {
    store.search(queryVector, { limit: 10 });
  }
  const endSearch = Date.now();
  
  const totalSearchTime = endSearch - startSearch;
  console.log(`Search queries executed in ${totalSearchTime}ms (avg ${(totalSearchTime / searchCount).toFixed(2)}ms/query).`);
  
  closeAllDbs();
  console.log("Benchmarks completed successfully.");
}

runBenchmark();
