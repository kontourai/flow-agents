# VHS tape — renders the side-by-side false-completion demo to GIF + MP4.
# Run from repo root:  vhs evals/acceptance/demo.tape
Output evals/acceptance/demo.gif
Output evals/acceptance/demo.mp4

Require bash
Require node

Set Shell bash
Set FontSize 16
Set Width 1500
Set Height 760
Set Padding 24
Set Margin 20
Set BorderRadius 10
Set PlaybackSpeed 1.0

# Flow Agents brand palette
Set Theme { "name": "FlowAgents", "background": "#151a22", "foreground": "#d8d3c8", "black": "#11120f", "red": "#c83b3b", "green": "#14a37a", "yellow": "#c9a35a", "blue": "#5a90c8", "magenta": "#c9a35a", "cyan": "#5ce0c6", "white": "#d8d3c8", "brightBlack": "#5f6975", "brightRed": "#c83b3b", "brightGreen": "#6fbf95", "brightYellow": "#c9a35a", "brightBlue": "#5a90c8", "brightMagenta": "#c9a35a", "brightCyan": "#5ce0c6", "brightWhite": "#ffffff", "cursor": "#c9a35a", "selection": "#2b3038" }

Hide
Type "cd /Users/brian/dev/github/kontourai/flow-agents && clear"
Enter
Show

Sleep 500ms
Type "bash evals/acceptance/demo-cast.sh"
Enter
Sleep 16s
