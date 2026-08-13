use scripting additions

property projectDir : "__TASKCENTER_PROJECT_DIR__"
property launcher : projectDir & "/scripts/taskcenter-control.sh"
property preferenceDomain : "com.taskcenter.desktop"

on run
    try
        ensureProjectAccess()
        set resultText to do shell script "/bin/bash " & quoted form of launcher & " start"
        display notification resultText with title "任务中心 TaskCenter"
    on error errorText
        do shell script "/bin/echo " & quoted form of errorText & " > /tmp/taskcenter-app-error.log"
        display notification errorText with title "TaskCenter 启动失败"
    end try
end run

on ensureProjectAccess()
    set authorizedPath to ""
    try
        set authorizedPath to do shell script "/usr/bin/defaults read " & preferenceDomain & " ProjectPath"
    end try
    if authorizedPath is projectDir then return

    set selectedFolder to choose folder with prompt "首次启动只需授权一次。请选择 TaskCenter 项目文件夹。" default location (POSIX file projectDir as alias)
    set selectedPath to POSIX path of selectedFolder
    if selectedPath ends with "/" then
        set selectedPath to text 1 thru -2 of selectedPath
    end if
    if selectedPath is not projectDir then
        error "请选择这个文件夹：" & projectDir
    end if
    do shell script "/usr/bin/defaults write " & preferenceDomain & " ProjectPath " & quoted form of projectDir
end ensureProjectAccess
