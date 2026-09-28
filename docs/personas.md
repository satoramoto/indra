# Yahaha personas

`personas/yahaha.json` gives each stable Yahaha seat a short, authored voice. These are software bots with musician inspirations, not the musicians themselves. Chick remains the Team Lead; the other four seats remain Developers. A musician's background or fun fact is third-person biographical context, not the bot's employment history or a claim that the musician endorses Indra.

Profiles are selected by seat ID. Existing display names and Mattermost usernames stay unchanged, including the two spelling differences below.

| Seat | Existing bot name / username | Musician inspiration and verified fact |
| --- | --- | --- |
| `seat-001` | Chick Corea / `chickcorea` | Jazz pianist and composer Chick Corea formed Return to Forever. His first major professional engagement was with Cab Calloway. [Official biography](https://chickcorea.com/bio/) |
| `seat-002` | George Duke / `georgeduke` | Pianist, producer, and composer George Duke worked across jazz, fusion, and funk. At the conservatory he majored in trombone and composition, with contrabass as his minor. [Official biography](https://www.georgedukemusic.com/bio) |
| `seat-003` | Aaron Magner / `aaronmagner` | **Aron Magner**, the Disco Biscuits keyboardist and SPAGA pianist, is the inspiration. After starting with classical piano, discovering jazz at 13 renewed his musical interest. The musician spells his first name **Aron**; the bot keeps **Aaron**. [SPAGA's official band biography](https://www.spagaband.com/) |
| `seat-004` | Corey Henry / `coreyhenry` | This profile draws on **Cory Henry**, the Brooklyn keyboardist, organist, former Snarky Puppy member, and Funk Apostles bandleader. He performed at the Apollo Theater at six. [SFJAZZ artist presentation](https://athome.sfjazz.org/videos/cory-henry-on-demand), [official biography](https://coryhenry.com/bio/) |
| `seat-005` | Jordan Rudess / `jordanrudess` | Dream Theater keyboardist Jordan Rudess has a classical piano background and develops music software. He began studying at Juilliard at nine. [Official biography](https://www.jordanrudess.com/biography/) |

The seat-004 profile selects keyboardist Cory Henry to follow the other four keyboardist inspirations. The existing roster does not establish that historical intent. **Corey Henry**, the New Orleans trombonist and Tremé Funktet bandleader, is a different musician ([his official biography](https://www.coreyhenrytremefunktet.com/bio)). Neither the bot's spelling nor its stable ID is changed.

The linked sources were read manually on 2026-09-28. Automated field and URL checks establish completeness, not biographical accuracy. Recheck the source when changing a fact; do not replace a musician fact with an invented fact about a seat number.

The shared persona loader and decorators belong to `src/seat-persona.ts`. Each profile uses their contract: `voice` sets the bot's authored manner, `background` identifies its role and musician inspiration, and `funFact` includes its source link. Prompts receive those three fields above either the Codex or Claude runtime. The optional `postPrefix` gives each bot a distinct phrase of at most eight words before its factual thread message, keeping repeated biographies out of progress posts.

Persona text must preserve the task's factual status, PR links, channel and thread routing, delivery IDs, and human approval instructions. Planning remains planning, and a fresh reviewer remains a separate, read-only session without the builder's history. A voice is never permission to invent progress or override those boundaries.

Profiles live in the Indra repository, not `indra-state` or its runtime metadata. Loading uses Indra's application root, so source execution and built execution (`dist` and `builds/<build>`) select the same repository profiles regardless of the working directory. An unknown seat falls back to the existing unadorned prompts and posts.

`tests/persona-profiles.test.ts` covers the complete roster, required fields and sources, selection, captured planning/build/review/fix prompts, posts and delivery recovery, both engines, and source/built loading. It uses local fakes rather than model calls or live Mattermost writes.
