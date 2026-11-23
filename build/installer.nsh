; Extra steps for the Windows installer (electron-builder includes build/installer.nsh by itself).
;
; Uninstall: asks whether the Docker data of ProjectDockHub should be deleted too.
;   No (the default, also in a silent uninstall): containers, volumes and images stay in Docker.
;     Installing ProjectDockHub again uses them again.
;   Yes: removes only what ProjectDockHub made, found by its own labels and names:
;     containers and volumes with the label com.<prefix>.managed=true,
;     the Compose networks <prefix>-<project>_default, and the images it built (<prefix>-<project>-php ...).
;     Images pulled from Docker Hub (nginx, mysql, phpmyadmin ...) stay, other tools may use them.
;   Project folders are never touched.
; An update runs the old uninstaller too; it must never ask or delete anything then.
; In NSIS strings, $$ is a single $ for PowerShell.

; The name prefix comes from naming.json in the project root, read while the installer is built.
!ifdef PROJECT_DIR
  !searchparse /noerrors /file "${PROJECT_DIR}\naming.json" `"prefix": "` NAME_PREFIX `"`
!endif
!ifndef NAME_PREFIX
  !define NAME_PREFIX "envhub"
!endif
!echo "Uninstaller name prefix: ${NAME_PREFIX}"

; Install: ProjectDockHub needs Docker. When it is not on this computer, offer to download and start the
; Docker Desktop installer (it asks for admin rights and sets up WSL 2 itself). No (the default, also in a
; silent install) skips it; the app then shows "Docker is not installed" with a Download button.
; Found = Docker Desktop is installed, or a docker command is on the PATH (Rancher Desktop and others).
; An update never asks.
!define DOCKER_DESKTOP_URL "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
!define DOCKER_DESKTOP_DOCS "https://docs.docker.com/desktop/setup/install/windows-install/"

!macro customInstall
  ${ifNot} ${isUpdated}
    StrCpy $R8 "missing"
    IfFileExists "$PROGRAMFILES64\Docker\Docker\Docker Desktop.exe" 0 +2
      StrCpy $R8 "found"
    ${if} $R8 == "missing"
      nsExec::Exec 'cmd.exe /c where docker'
      Pop $R9
      ${if} $R9 == 0
        StrCpy $R8 "found"
      ${endIf}
    ${endIf}
    ${if} $R8 == "missing"
      MessageBox MB_YESNO|MB_ICONINFORMATION "ProjectDockHub needs Docker, and Docker is not installed on this computer.$\r$\n$\r$\nDownload and install Docker Desktop now? It is free, about 600 MB. Its installer asks for admin rights and may ask you to restart the computer.$\r$\n$\r$\nNo: install it later. ProjectDockHub shows a Download Docker button when it starts." /SD IDNO IDNO envhub_skip_docker
        DetailPrint "Downloading Docker Desktop..."
        inetc::get /CAPTION "Downloading Docker Desktop" /BANNER "Downloading Docker Desktop (about 600 MB). This can take a few minutes." "${DOCKER_DESKTOP_URL}" "$TEMP\DockerDesktopInstaller.exe" /END
        Pop $R9
        ${if} $R9 == "OK"
          DetailPrint "Starting the Docker Desktop installer..."
          ; ExecShell, so Windows can ask for admin rights (the Docker installer needs them).
          ExecShell "open" "$TEMP\DockerDesktopInstaller.exe"
        ${else}
          MessageBox MB_OK|MB_ICONEXCLAMATION "Docker Desktop could not be downloaded ($R9).$\r$\n$\r$\nThe download page opens now. Install Docker Desktop from there, then start ProjectDockHub." /SD IDOK
          ExecShell "open" "${DOCKER_DESKTOP_DOCS}"
        ${endIf}
      envhub_skip_docker:
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Delete the Docker data of ProjectDockHub too?$\r$\n$\r$\nYes: removes every ProjectDockHub container, its Docker volumes (the database data: all tables and rows) and the images it built. This cannot be undone.$\r$\n$\r$\nNo: keeps them in Docker. If you install ProjectDockHub again, your projects and databases are still there.$\r$\n$\r$\nYour project folders are not deleted either way." /SD IDNO IDNO envhub_keep_docker
      DetailPrint "Removing the Docker containers, volumes and images of ProjectDockHub..."
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "docker info *> $$null; if ($$LASTEXITCODE -ne 0) { exit 3 }; $$c = docker ps -aq --filter label=com.${NAME_PREFIX}.managed=true; if ($$c) { docker rm -f -v $$c | Out-Null }; $$v = docker volume ls -q --filter label=com.${NAME_PREFIX}.managed=true; if ($$v) { docker volume rm -f $$v | Out-Null }; $$n = docker network ls -q --filter name=${NAME_PREFIX}- --filter label=com.docker.compose.project; if ($$n) { docker network rm $$n | Out-Null }; $$i = docker images -q --filter reference=${NAME_PREFIX}-* | Sort-Object -Unique; if ($$i) { docker rmi -f $$i | Out-Null }; exit 0"'
      Pop $0
      ${if} $0 == 3
        MessageBox MB_OK|MB_ICONEXCLAMATION "Docker is not running, so nothing was deleted from Docker.$\r$\n$\r$\nTo remove the data later: open Docker Desktop and delete the containers and volumes whose names start with ${NAME_PREFIX}-." /SD IDOK
      ${elseIf} $0 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "Some ProjectDockHub Docker data could not be removed (code $0).$\r$\n$\r$\nYou can delete the rest in Docker Desktop: containers, volumes and images whose names start with ${NAME_PREFIX}-." /SD IDOK
      ${endIf}
    envhub_keep_docker:
  ${endIf}
!macroend
