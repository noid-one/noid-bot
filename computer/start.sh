#!/bin/sh
# The computer's main process (under tini): the folders bots work in, and its desktop. The desktop is a real one, as
# rakazo's: a window manager with a taskbar, a session bus, and the one browser (noid-browser), which the owner uses
# there by hand and bots reach over DevTools while they work.
mkdir -p "$HOME/bots" "$HOME/shared" "$HOME/.local/bin" /tmp/noid
# The display, started again from here when it stops (below). /tmp survives `docker restart`, and a display that stopped
# hard leaves its lock and socket: Xvfb would refuse to start, and a program would find the socket and fail on it.
display() {
    rm -f /tmp/.X100-lock /tmp/.X11-unix/X100
    Xvfb :100 -screen 0 1280x800x24 -nolisten tcp >>/tmp/noid/xvfb.log 2>&1 &
    xvfb=$!

    i=0
    while [ ! -S /tmp/.X11-unix/X100 ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
}

# fluxbox writes its settings back: a copy of noid's in a home of its own. It goes when the display does.
desktop() {
    mkdir -p /tmp/noid/fluxbox/.fluxbox
    cp /etc/noid/fluxbox/init /tmp/noid/fluxbox/.fluxbox/init
    HOME=/tmp/noid/fluxbox fluxbox -rc /tmp/noid/fluxbox/.fluxbox/init >>/tmp/noid/fluxbox.log 2>&1 &
    fluxbox=$!
}

: >/tmp/noid/xvfb.log
: >/tmp/noid/fluxbox.log
display

# Chromium expects a session bus; programs started later (the browser, from noid-browser) find it in this file.
eval "$(dbus-launch --sh-syntax)"
printf "export DBUS_SESSION_BUS_ADDRESS='%s'\n" "$DBUS_SESSION_BUS_ADDRESS" >/tmp/noid/dbus-session

desktop

# A container whose display died still shows as running, and every desktop and browser action would fail on it until
# someone restarted the computer: the display and the desktop come back by themselves instead, within a few seconds.
# The browser went with the display; noid starts it again when a bot or the owner next needs it.
# Running, not gone or a zombie not yet reaped (`kill -0` takes a zombie for running).
alive() {
    [ -r "/proc/$1/stat" ] && [ "$(cut -d' ' -f3 "/proc/$1/stat")" != Z ]
}

while sleep 2; do
    if ! alive "$xvfb"; then
        echo "noid: the display stopped; starting it again" >>/tmp/noid/xvfb.log
        kill "$fluxbox" 2>/dev/null
        display
        desktop
    elif ! alive "$fluxbox"; then
        echo "noid: the desktop stopped; starting it again" >>/tmp/noid/fluxbox.log
        desktop
    fi
done
