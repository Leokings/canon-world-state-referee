# Example fixture

These files describe one small immutable deployment policy. The constructor receives the canon, initial state, and transition catalog as compact JSON **strings**; `constructor-args.json` shows the exact five arguments.

Only the deploying controller may call `adjudicate_transition`. Read `get_world_state()` and replace `READ_THIS_FROM_get_world_state` with the returned `state_digest`. The submitted complete state must equal current state plus the transition's exact registered `state_patch`. A successful semantic judgment activates only that deterministic patch; neither caller nor model selects state effects.
