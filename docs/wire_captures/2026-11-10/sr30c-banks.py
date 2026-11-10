import sys, time, os
sys.argv = ["x", "/dev/cu.usbserial-02A72C10"]
src = open("sr30c-probe.py").read().split("def main():")[0]
exec(src)
fd = open_port(sys.argv[1], termios.B57600); time.sleep(0.4)
for _ in range(2): send(fd, "MDL")
show("PRG", send(fd, "PRG"))
for i in [1, 50, 51, 52, 100, 101, 150, 151, 200, 201, 250, 251, 300, 301, 350, 351, 400, 401, 450, 451, 500]:
    show(f"CIN,{i}", send(fd, f"CIN,{i}"))
show("EPG", send(fd, "EPG")); os.close(fd)
