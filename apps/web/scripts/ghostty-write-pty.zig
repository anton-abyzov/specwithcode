extern "env" fn studio_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void;

export fn ghostty_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void {
    studio_write_pty(terminal, userdata, data, len);
}
