import os
import json
import glob

def find_latest_report(directory="reports"):
    # Find all fs-check JSON files and get the most recent one
    files = glob.glob(os.path.join(directory, "**", "fs-check-*.json"), recursive=True)
    if not files:
        print("No fs-check JSON reports found in the 'reports' directory.")
        return None
    return max(files, key=os.path.getctime)

def main():
    latest_file = find_latest_report()
    if not latest_file:
        return

    print(f"--- Parsing: {latest_file} ---\n")
    
    with open(latest_file, 'r') as f:
        data = json.load(f)

    print("=== TOP LEVEL STATUS ===")
    print(f"Verified Success: {data.get('verified')}")
    print(f"Status: {data.get('status')}")
    print(f"Error: {data.get('error', 'None')}\n")

    fs_data = data.get("fs", {})
    acq = fs_data.get("acquisition", {})
    
    print("=== FAILURE SUMMARY ===")
    summary = acq.get("failureSummary", {})
    if summary:
        print(f"Kind: {summary.get('kind')}")
        print(f"Message: {summary.get('message')}")
        print(f"Unjoined Threads: {summary.get('resources', {}).get('unjoinedThreads')}")
        print(f"Handles Open: {summary.get('resources', {}).get('handles')}\n")
    else:
        print("No failure summary recorded.\n")

    print("=== RACE WAVE SUMMARY ===")
    batches = fs_data.get("retryBatches", [])
    if not batches:
        print("No waves were attempted (likely failed during setup or handle allocation).")
    else:
        for batch in batches[-3:]: # Show last 3 batches
            print(f"Profile: {batch.get('profile')}")
            print(f"  Status: {batch.get('status')}")
            print(f"  Attempts Started: {batch.get('attemptsStarted')}")
            print(f"  Qualified Windows: {batch.get('qualifiedWindows')}")
            print(f"  Marker Hits: {batch.get('markerHits')}")
            print(f"  Native Aborts (Trigger aborted): {batch.get('aborted')}")
            print(f"  Restorations Failed: {batch.get('restorationFailures')}")
            print("-" * 20)

    print("\n=== LAST 3 CASES (If any) ===")
    cases = fs_data.get("lastCases", [])
    if not cases:
        print("No individual race cases were recorded.")
    else:
        for i, case in enumerate(cases):
            print(f"Case {i+1}: Profile: {case.get('profile')}")
            print(f"  Restored: {case.get('restored')}")
            print(f"  All Pending (Overlap): {case.get('allPending')}")
            print(f"  Canary Changed: {case.get('changedPaths')}")
            print(f"  Trigger Aborted: {case.get('triggerAborted')}")
            print(f"  Native Guard: {case.get('nativeGuard')}")

if __name__ == "__main__":
    main()