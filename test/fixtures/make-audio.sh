#!/bin/bash
# Generates English test speech with macOS `say` (no external API) and converts to 16 kHz mono WAV.
set -e
cd "$(dirname "$0")/audio"
gen() { # name voice rate text
  say -v "$2" -r "$3" -o "$1.aiff" "$4"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$1.aiff" "$1.wav" >/dev/null
  rm -f "$1.aiff"
}
gen q01_status      Samantha 175 "So, what's the current status of your game project, and when do you plan to launch it?"
gen q02_restate     Samantha 175 "How many users do you have right now? Actually, sorry, forget that. What I really wanted to ask is, how are you planning to use AI inside the game?"
gen q03_long        Daniel   170 "Let me give you some context first. We have been looking at a few blockchain games this quarter, and most of them struggle with onboarding. Players do not want to deal with wallets. So my question is this: how does your project handle onboarding for players who have never used a wallet before?"
gen q04_fast        Samantha 240 "Quick one. Which chain are you on, and why did you choose it over the alternatives?"
gen q05_names       Daniel   175 "Is Zentoria built on Solana, and is the budget around fifteen thousand dollars by March third?"
gen q06_contract    Samantha 170 "Can you commit to a fixed price of twenty thousand dollars and sign the contract this week?"
gen q07_outside     Daniel   175 "What is your opinion on the latest Unreal Engine pricing changes announced last month?"
gen q08_negation    Samantha 175 "Do you plan to raise money this year? No wait, not this year. I mean next year. Are you planning to raise a seed round next year?"
gen q09_short       Daniel   175 "Why?"
gen q10_statement   Samantha 175 "That sounds great. Thanks for walking us through the demo."
# overlapping speakers: mix two utterances with an offset
say -v Samantha -r 175 -o ov_a.aiff "Could you tell us more about the team behind the project?"
say -v Daniel   -r 175 -o ov_b.aiff "And also, what is the timeline for the mainnet launch?"
ffmpeg -loglevel error -y -i ov_a.aiff -i ov_b.aiff -filter_complex "[1:a]adelay=1200|1200[b];[0:a][b]amix=inputs=2:duration=longest" -ar 16000 -ac 1 q11_overlap.wav
rm -f ov_a.aiff ov_b.aiff
# silence then speech (gap handling)
ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 4 silence4.wav
ffmpeg -loglevel error -y -i silence4.wav -i q09_short.wav -i silence4.wav -i q04_fast.wav -filter_complex "[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1" -ar 16000 -ac 1 q12_gaps.wav
rm -f silence4.wav
# a full "meeting" sequence: several questions with pauses, for latency measurement
ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 2.5 pause.wav
ffmpeg -loglevel error -y -i q01_status.wav -i pause.wav -i q02_restate.wav -i pause.wav -i q05_names.wav -i pause.wav -i q06_contract.wav -i pause.wav -i q07_outside.wav -i pause.wav -i q08_negation.wav -filter_complex "[0:a][1:a][2:a][3:a][4:a][5:a][6:a][7:a][8:a][9:a][10:a]concat=n=11:v=0:a=1" -ar 16000 -ac 1 meeting01.wav
rm -f pause.wav
ls -la *.wav
