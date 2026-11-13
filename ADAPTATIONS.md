# Local changes for 20.4.0 v0.7.0

This separate package retains the verified save backup, independent proof
verification, cooperative stop, explicit target environment, working native
bridge and the pinned upstream race, geometry and restoration controls.

- Release the owned RomFS metadata copy after size validation, before cloning.
- Reuse the base save handle for commit. Host operations finish before waves.
- Alias temporary=save for serial host operations; share the trigger only across
  sequential wave types. Concurrent roles retain distinct connections.
- Build the full thirteen-session setup with ten clones before scratch writes.
  The previous successful diagnostic tested eight clones and eleven handles.
- Monitor clone and pointer-buffer controls using a separate one-MiB allocation
  and the tested event/frame/stack layout, with scheduling borrowed from live
  game threads. Read replies only after kernel termination. Returned handles
  belong to the main session. Pending or uncertain thread launches retain both
  allocations and all source resources. No late spare release or automatic retry.
- Release the monitor before FS waves; retain native wave IPC and timings.
- Preflight staged runtime imports with materialized profiles before connecting.
- Include topology, peak owned handles, last monitored request, monitor cleanup
  and whether scratch writes were attempted in the summary JSON.
- Require monitor cleanup and allocation ownership for acquisition cleanup proof.

No upstream repository was edited. No firmware-specific system FS/RO/PM offsets
are asserted; the inherited FS geometry must still pass native controls.
