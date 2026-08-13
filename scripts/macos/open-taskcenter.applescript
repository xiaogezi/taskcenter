on run argv
    set targetURL to "http://localhost:3000"
    if (count of argv) > 0 then set targetURL to item 1 of argv

    if application "Google Chrome" is running then
        tell application "Google Chrome"
            repeat with windowIndex from 1 to count of windows
                set currentWindow to window windowIndex
                repeat with tabIndex from 1 to count of tabs of currentWindow
                    set currentTab to tab tabIndex of currentWindow
                    if URL of currentTab starts with targetURL then
                        set active tab index of currentWindow to tabIndex
                        set index of currentWindow to 1
                        activate
                        return
                    end if
                end repeat
            end repeat
            open location targetURL
            activate
        end tell
    else
        open location targetURL
    end if
end run
