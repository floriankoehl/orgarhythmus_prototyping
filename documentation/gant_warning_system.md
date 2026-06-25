Warning system — rules and behavior
What counts as a rule break
Milestone overlap

Two milestones belonging to the same note cannot occupy the same day. A note's timeline is exclusive — each day can only be held by one milestone at a time.
Hard deadline violation

A milestone cannot be moved past its note's hard deadline. Hard deadlines are absolute — they represent a real-world constraint that cannot be negotiated within the system. Additionally, no milestone can be moved before today's date. Both boundaries are treated as walls.
Dependency violation

If milestone A must finish before milestone B starts, then B can never start on the same day A finishes or earlier. This relationship is directional and must always be respected — regardless of how many milestones are being moved, resized, or connected at once.




What happens for each rule break

Milestone overlap

The move is blocked. You literally can not go beyond that milestone with dragging, so you just see that you are clearly BOUND. BUT, because a milestone blocking the other milestone from moving past it in a note always means that the note is opened, and not collapsed, meaning, that it will always be visible, therefore there does not have to be any collapsing and expanding logic done here... Depending on the selection the user has in the warning system setting, the blocking milestone is auto-selected and movable. OR, the violation is simply visualised and nothing else can be really done. Because you can not move past it. The move is physically stopped at the boundary during drag.

Hard deadline violation

The move is physically stopped at the boundary during drag — the milestone cannot even reach the invalid position. A notification appears informing the user which boundary was hit. Nothing needs to be selected because the boundary itself is visible.



Dependency violation

The move is blocked and everything snaps back to the previous valid state. The dependency arrow between the conflicting milestones blinks red to make the broken relationship visible. Depending on the selection the user has in the warning system setting, the blocking milestone is auto-selected and movable. OR, the


Whenever the selection is applied that it should auto select - the milestone should be added to a list of selected milestones (which should already be there) and movable together, so both milestones can be dragged simultanously. Not, that should be accumalative. So if you for example want to move a but b blocks it, then a and b is selected (of course only if the users selected that setting), and then you can move both togehter, but if now c blocks b for example, then of course c should be added to the selected items and not only select b and c, so the result should be a, b and c selected, and that should go on "infinitely". So if c is blocked by d then, you d should be added and so on. 

If either milestone is hidden inside a collapsed section, that section is expanded so the conflict is always visible.

I will describe this situtation in more detail later, because this is actually quite a complicated situation and i call it the collapse/expand dillema. 

If multiple dependency violations occur in the same action, all of them are reported together and all blocking milestones are selected at once. The entire action is rejected as a whole — there is no partial acceptance. This is already implemented by the system of a "move" or a "transaction" in the backend. So a move is atomatic, and that is also the thing that should be redone undone and done again.. 



The collapse/expand dilemma


What can be collapsed:
- Category lane collapse — an entire category lane (e.g. "Marketing") is collapsed.
- Note collapse (the row itself)


The Filtering System: 
- Dimension for the color picker can be picked, and there, a certain category is filtered, or certain categories are filtered. This can be done in 2 ways - via a quick filer, or actually, via a "named filter", which is bascially CROSS dimensional. So you can have a filter applied to two dimensions categories. 

if you for example have dimensions "priority" category "hard" AND dimension "difficulty" category "easy" this is a filter. And a filter also has effect if a task is shown or NOT. 


What the collapse/expand dillema is, is that, for both scenarios the user can pick, so first of all, that all the blocking milestones are not selcted. 
The principle is that the milestone blocking still needs to be visualised. EVEN if the blocking milestone auto select thing is not activated, its a necessity that you still visualyl at least see which milestone stopped it, and for the auto select, you should even select it. 

The problem for both things respectively are now this:
- If you just visualize the blocking milestone and then go back to the preious state, you have to precisely make sure the actually safe the exact visual representation before "undoing" it, and then reapplying that same visual representation safed earlier again after a certain time threshold is over (now 3 seconds i think). This is actually not that easy, because as i said, there are 3 differnt way. Either the note itself being collapsd, the category of that note being collapsed, or they are filtered by either a quick filter or named filter. But this can actually quite "easily" be solved, but just using the same principle of the perspectives and safe it before it, and reapplying. 
The main problem is, that you have to be aware of every possible way a note can be collapsed and that you somehow have to expand it again. And then go back to the original way. 




- If you now do NOT collapse it back in, the problem is a inconsistency in the frontend. So if you are having a filter applied for example and then expand the breaking milestones note because of that rulebreak, does the filter have to be stopped entirely for that rule break? But then you have entirely no overview anymore. Or should just for this specific note, that blocks it, or multiple notes, that block them, be an excpetion and they should be visualized, against the rule of the frontend change? For this, i would simply live with the fact of this short frontend inconistency to be honest. so this one is also reasonable to solve. 


But this thing as a whole is the entire complicated situation i was talking about.. 



How the restore works
Before expanding anything, the system takes a snapshot of the complete current perspective state — exactly the same data structure used by the named perspective system, just held in memory rather than saved to the database. After 3 seconds, restoring is identical to switching back to a saved perspective. The same code path, just triggered automatically.





Why transactions are connected to the warning system
The warning system's job is to ensure the Gantt is always in a valid state. The transaction system's job is to ensure every change is atomic. These two naturally meet at the same point — the moment a change is rejected.
When the backend rejects a transaction because it violates a rule, the transaction system snaps everything back to the pre-transaction state. This is exactly what the warning system needs — a guaranteed clean rollback before it starts highlighting conflicts and selecting blocking milestones. Without the transaction system, a partial state change could have already happened before the warning fires, meaning the warning is now pointing at a state that never should have existed.