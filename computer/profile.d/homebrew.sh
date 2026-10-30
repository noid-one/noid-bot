# Login shells (the terminal page's) get PATH from /etc/profile, which drops the image's: Homebrew's bin/ goes back on,
# after the system's, as the image has it.
case ":$PATH:" in
    *:/home/linuxbrew/.linuxbrew/bin:*) ;;
    *) PATH="$PATH:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin" ;;
esac
