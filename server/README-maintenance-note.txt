The five-minute Apps Script maintenance trigger now owns:
- fermentor Sheet -> Firestore refresh
- Sheet pull freshness heartbeat
- durable app -> Sheet outbox retries
- planning checkpoint snapshots
- queued operational log flush

This consolidation is intentional to stay within the free Apps Script/Firebase setup and avoid duplicate scheduled executions.
