# Control Room: all-order evidence audit

Snapshot: 2026-10-21T09:00:00.000Z. Checked 100 orders: **40 need attention**, **60 stay quiet**. 23 were missed by the former stored-alert-only filter.

Priority review: 9 · Needs review: 18 · Follow-up: 13 · Manual control: 0

Tracking policy: review active trips after four hours without a fresh driver-app observation, or when the active assignment has no driver-app position. Use observed and received times at the dataset snapshot. A recent upload of old data, a different assignment, or an inferred location does not restore freshness. Fresh coarse signals alone do not require review.

Also assess unresolved incidents/claims, rejected or missing required handover evidence, selected pickup/delivery timing, pending or failed agent work, open work items, verification checks, owned waits/custody checks, and confirmed open inbox work. An open conversation or unconfirmed inbox candidate alone does not diagnose an order problem. Future owned checks stay in Follow-up; overdue checks require review. Explicit Follow-up/Manual ownership takes precedence over historical severity.

These are derived review signals. The source dataset and its recorded alert histories were not modified.

| Order | Order state | Review group | Reason and source |
| --- | --- | --- | --- |
| CD-420004 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420009 | NEW | Follow-up (new) | Waiting on the customer's vehicle identity [conv-x0d98299030fa18f5; 2026-10-21T11:00:00Z]; Identity input required [work-x536223efaa59e0b6; 2026-10-21T15:00:00Z] |
| CD-420010 | NEW | Follow-up (new) | Pickup contact handle required [work-xe5ffe78960670002; 2026-10-21T15:00:00Z] |
| CD-420014 | WAITING_FOR_PICKUP | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420015 | NEW | Follow-up (new) | Waiting on site confirmation [conv-x636a004c01e1dcbd; 2026-10-21T10:00:00Z] |
| CD-420020 | DELIVERED | Follow-up (new) | Waiting on operator follow-up [conv-x44f5f8b07eccc04e; 2026-10-21T13:00:00Z] |
| CD-420023 | NEW | Follow-up (new) | Pickup access check required [work-x63c3d7a51c26655e; 2026-10-21T15:00:00Z] |
| CD-420055 | DELIVERED | Needs review | Open alert: Condition claim review [alert-x15a3a8c8be8357bf; 2026-10-21T07:44:00.000Z]; Agent proposal awaiting review [agent-x67ebc5bd109d4ac1; 2026-10-21T08:28:00Z] |
| CD-420071 | IN_TRANSIT | Follow-up | Owned alert: Pickup proof rejected [alert-x2ac9aec67ad85d7a; 2026-10-20T13:10:00Z]; Pickup evidence followup [work-xbe01b6d42115ad62; 2026-10-21T10:00:00Z] |
| CD-420075 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420089 | WAITING_FOR_PICKUP | Needs review (new) | Pickup details not verified for this order [ep-x9ba88828235d1691] |
| CD-420111 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420118 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420123 | WAITING_FOR_PICKUP | Needs review (new) | Pickup details not verified for this order [ep-xf09aaa14b82ddde0] |
| CD-420145 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420154 | WAITING_FOR_PICKUP | Follow-up | Approved proposal not yet executed [agent-x68cbbd7e6e58691c; 2026-10-21T08:42:00Z]; Owned alert: French import travel decision [alert-xe7b44c310860f4c5; 2026-10-21T08:34:00Z] |
| CD-420164 | DELIVERED | Needs review | Open alert: Proof review [alert-x450a8bb94b6b80c7; 2026-10-19T09:48:00.000Z]; Signed handover followup [work-xaccd8ed37a28afc8; 2026-10-19T11:39:00Z] |
| CD-420177 | DELIVERED | Quiet | Only conversation context or an unconfirmed inbox candidate; no independently actionable issue. |
| CD-420194 | DELIVERED | Needs review | Open alert: Invoice reference query [alert-x5e2a521421e447cb; 2026-10-21T06:12:00.000Z]; Approved proposal not yet executed [agent-xf874ddfecf02bb68; 2026-10-21T08:33:00Z] |
| CD-420201 | WAITING_FOR_PICKUP | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420222 | NEW | Follow-up (new) | Support inbox thread linked to this order [inbox-x0c469506e2c5b685; 2026-10-21T08:01:00Z] |
| CD-420240 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420257 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420291 | DELIVERED | Follow-up (new) | Support inbox thread linked to this order [inbox-xa3da181b78fb1235; 2026-10-21T08:24:00Z] |
| CD-420299 | WAITING_FOR_PICKUP | Priority review | Incident: Travel capacity [incident-x33db4a88b8994b7b; 2026-10-21T07:00:00Z]; Agent action failed [agent-x4ac988b20000595f; 2026-10-21T07:10:00Z]; Agent proposal awaiting review [agent-xde17f642729c5339; 2026-10-21T08:16:00Z]; Owned alert: Ferry sold out [alert-x91c0e327c701d1e7; 2026-10-21T08:36:00Z] |
| CD-420311 | WAITING_FOR_PICKUP | Needs review (new) | Pickup details not verified for this order [ep-xb5fb4a7b67662836] |
| CD-420322 | IN_TRANSIT | Priority review | Incident: Vehicle warning [incident-x589908b2ed24936a; 2026-10-21T08:07:00Z]; Open alert: Tracking gap [alert-x105238e92e7f3ba6; 2026-10-21T05:16:00.000Z]; Vehicle recovery decision [work-xbfed2fad876cbd13; 2026-10-21T09:15:00Z]; Owned alert: Safety stop [alert-x539dcfdd5a51d9ab; 2026-10-21T08:34:00Z] |
| CD-420324 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420326 | IN_TRANSIT | Follow-up (new) | Waiting on a corrected expense review [conv-x466f755555679452; 2026-10-21T11:00:00Z] |
| CD-420335 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420338 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420342 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420347 | NEW | Needs review | Open alert: Site access conflict [alert-xdc098cd0772eab0b; 2026-10-21T06:26:00.000Z]; Market visibility check [work-xe272ce380e9dd375; 2026-10-21T09:10:00Z]; Waiting on site confirmation [conv-x6a97a306c4e04153; 2026-10-21T12:00:00Z] |
| CD-420360 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420362 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420366 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420384 | WAITING_FOR_PICKUP | Follow-up (new) | Custody check: Keys for the second car in a two-leg driver plan [custody-x96b53a7c6cc48555; 2026-10-27T06:00:00Z] |
| CD-420399 | WAITING_FOR_PICKUP | Needs review | Driver start check [work-x4cb7fd705c117b64; 2026-10-21T09:30:00Z]; Agent proposal awaiting review [agent-xb914e837479457b7; 2026-10-21T08:27:00Z]; Pickup details not verified for this order [ep-x936527910aa768c9]; Owned alert: Positioning at risk [alert-x6ef8fbd869be9ac5; 2026-10-21T08:58:00Z] |
| CD-420404 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420405 | WAITING_FOR_PICKUP | Needs review (new) | Pickup details not verified for this order [ep-x2a6632ae98b35786] |
| CD-420412 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420413 | WAITING_FOR_PICKUP | Quiet | Only conversation context or an unconfirmed inbox candidate; no independently actionable issue. |
| CD-420419 | WAITING_FOR_PICKUP | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420437 | IN_TRANSIT | Priority review | Open alert: Delivery access risk [alert-x6fc9eee283ddbfd5; 2026-10-20T09:46:00.000Z]; Receiver authority check [work-x6c27e55269d19e01; 2026-10-21T08:58:00Z] |
| CD-420439 | IN_TRANSIT | Priority review (new) | Delivery promise needs review [win-x12ea353b84ae5678; 2026-10-26T13:00:00Z] |
| CD-420442 | WAITING_FOR_PICKUP | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420449 | WAITING_FOR_PICKUP | Needs review | Open alert: Driver availability risk [alert-xd6b460da263340c0; 2026-10-20T10:35:00.000Z]; Backup driver decision [work-x886e3f205f976c90; 2026-10-20T11:21:00Z]; Approved proposal not yet executed [agent-xf4800bb1b907cf89; 2026-10-21T08:00:00Z]; Pickup details not verified for this order [ep-x0e883fed1a5dd9b3] |
| CD-420452 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420455 | DELIVERED | Priority review | Incident: Post-delivery condition claim [incident-x9aeabfc672bd296d; 2026-10-21T07:32:00Z]; Open alert: Condition claim [alert-xb71481bda30b3ff5; 2026-10-21T07:55:00.000Z] |
| CD-420458 | NEW | Priority review | Open alert: Release document unclear [alert-xad90176c4d6e6fc5; 2026-10-19T11:01:00.000Z]; Commercial release hold [work-x034712fe38184350; 2026-10-21T10:00:00Z]; Waiting on seller hold clearance [conv-xb088d8b061f794e5; 2026-10-21T10:00:00Z] |
| CD-420516 | NEW | Needs review | Open alert: Site access unconfirmed [alert-x9dd9663e6059eeba; 2026-10-19T10:46:00.000Z]; Key holder stock check [work-x2174da059fcd89e8; 2026-10-21T09:15:00Z]; Waiting on a stock control reply [conv-x53b0830c80a6336b; 2026-10-21T10:00:00Z] |
| CD-420531 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420537 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420576 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420578 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420579 | WAITING_FOR_PICKUP | Needs review (new) | Pickup details not verified for this order [ep-xedf3a2c7a0931c33] |
| CD-420584 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420585 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420593 | WAITING_FOR_PICKUP | Priority review | Incident: Empty pickup [incident-xa3273de530f17fd8; 2026-10-21T07:12:00Z]; Pickup slot needs review [win-x424e4bf04450af43; 2026-10-21T08:00:00Z]; Agent proposal awaiting review [agent-x6ad46f8e74398f5e; 2026-10-21T08:01:00Z]; Pickup details not verified for this order [ep-xfa0577c45735dc91]; Owned alert: Empty pickup [alert-xd736bb2556e316a6; 2026-10-21T08:28:00Z] |
| CD-420603 | IN_TRANSIT | Priority review | Open alert: Ferry connection risk [alert-x5259ff7f2e03f0e6; 2026-10-21T07:00:00.000Z]; Approved proposal not yet executed [agent-x1c721af5508e707a; 2026-10-21T07:59:00Z] |
| CD-420612 | DELIVERED | Needs review (new) | Delivery photos: rejected [proof-x1a6c51d3a362f8e8; 2026-10-16T07:24:00Z] |
| CD-420619 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420656 | WAITING_FOR_PICKUP | Quiet | Only conversation context or an unconfirmed inbox candidate; no independently actionable issue. |
| CD-420666 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420671 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420675 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420679 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420689 | NEW | Needs review (new) | Site handover review [work-x7956a83380dc9cba; 2026-10-21T09:20:00Z] |
| CD-420692 | NEW | Quiet | Only conversation context or an unconfirmed inbox candidate; no independently actionable issue. |
| CD-420694 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420697 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420702 | IN_TRANSIT | Priority review | Open alert: Delivery promise unachievable [alert-x9cd05869f6be7f09; 2026-10-21T08:28:00.000Z]; Yard release photos: required [proof-xff832a775d95642d] |
| CD-420710 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420719 | WAITING_FOR_PICKUP | Quiet | Only conversation context or an unconfirmed inbox candidate; no independently actionable issue. |
| CD-420725 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420735 | IN_TRANSIT | Needs review (new) | Moving with no driver-app position [asg-xfda77544f42fc3fe; 2026-10-21T07:33:00Z] |
| CD-420747 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420806 | IN_TRANSIT | Needs review (new) | Driver-app tracking is stale [track-xf0422caacf2d28ce; 2026-10-21T02:12:00Z] |
| CD-420837 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420904 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420917 | IN_TRANSIT | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420941 | NEW | Follow-up (new) | Site handover review [work-xf5532facef1d865b; 2026-10-21T09:20:00Z] |
| CD-420958 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420961 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420987 | DELIVERED | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-420992 | WAITING_FOR_PICKUP | Follow-up (new) | Driver start check [work-x15f6ebbff418e44c; 2026-10-21T09:20:00Z] |
| CD-421010 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421011 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421013 | IN_TRANSIT | Needs review (new) | Moving with no driver-app position [asg-x7d7212e3bd4bbecb; 2026-10-21T04:55:00Z] |
| CD-421022 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421024 | WAITING_FOR_PICKUP | Needs review (new) | Pickup details not verified for this order [ep-xe62573e92ddbb1c4] |
| CD-421027 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421035 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421038 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421042 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421044 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421048 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421051 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421053 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
| CD-421056 | NEW | Quiet | No active alert, blocked work, outstanding check or stale/missing active-trip evidence. |
