Warning system — rules and behavior
What counts as a rule break
Milestone overlap

Two milestones belonging to the same goal cannot occupy the same day. A goal's timeline is exclusive — each day can only be held by one milestone at a time.
Hard deadline violation

A milestone cannot be moved past its goal's hard deadline. Hard deadlines are absolute — they represent a real-world constraint that cannot be negotiated within the system. Additionally, no milestone can be moved before today's date. Both boundaries are treated as walls.
Dependency violation

If milestone A must finish before milestone B starts, then B can never start on the same day A finishes or earlier. This relationship is directional and must always be respected — regardless of how many milestones are being moved, resized, or connected at once.




What happens for each rule break

Milestone overlap

The move is blocked. You literally can not go beyond that milestone with dragging, so you just see that you are clearly BOUND. BUT, because a milestone blocking the other milestone from moving past it in a goal always means that the goal is opened, and not collapsed, meaning, that it will always be visible, therefore there does not have to be any collapsing and expanding logic done here... Depending on the selection the user has in the warning system setting, the blocking milestone is auto-selected and movable. OR, the violation is simply visualised and nothing else can be really done. Because you can not move past it. The move is physically stopped at the boundary during drag.

Hard deadline violation

The move is physically stopped at the boundary during drag — the milestone cannot even reach the invalid position. A notification appears informing the user which boundary was hit. Nothing needs to be selected because the boundary itself is visible.



Dependency violation

The move is blocked and everything snaps back to the previous valid state. The dependency arrow between the conflicting milestones blinks red to make the broken relationship visible. Depending on the selection the user has in the warning system setting, the blocking milestone is auto-selected and movable. OR, the




