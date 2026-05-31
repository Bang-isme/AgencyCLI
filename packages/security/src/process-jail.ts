
let koffi: any = null;
let libKernel32: any = null;

// Win32 function pointers
let CreateJobObjectW: any = null;
let SetInformationJobObject: any = null;
let OpenProcess: any = null;
let AssignProcessToJobObject: any = null;
let TerminateJobObject: any = null;
let CloseHandle: any = null;
let JOBOBJECT_EXTENDED_LIMIT_INFORMATION: any = null;

if (process.platform === "win32") {
  try {
    koffi = (await import("koffi")).default;
    libKernel32 = koffi.load("kernel32.dll");

    const JOBOBJECT_BASIC_LIMIT_INFORMATION = koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION", {
      PerProcessUserTimeLimit: "int64",
      PerJobUserTimeLimit: "int64",
      LimitFlags: "uint32",
      MinimumWorkingSetSize: "size_t",
      MaximumWorkingSetSize: "size_t",
      ActiveProcessLimit: "uint32",
      Affinity: "uintptr_t",
      PriorityClass: "uint32",
      SchedulingClass: "uint32"
    });

    const IO_COUNTERS = koffi.struct("IO_COUNTERS", {
      ReadOperationCount: "uint64",
      WriteOperationCount: "uint64",
      OtherOperationCount: "uint64",
      ReadTransferCount: "uint64",
      WriteTransferCount: "uint64",
      OtherTransferCount: "uint64"
    });

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION = koffi.struct("JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
      BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
      IoInfo: IO_COUNTERS,
      ProcessMemoryLimit: "size_t",
      JobMemoryLimit: "size_t",
      PeakProcessMemoryUsed: "size_t",
      PeakJobMemoryUsed: "size_t"
    });

    CreateJobObjectW = libKernel32.func("CreateJobObjectW", "void *", ["void *", "str16"]);
    SetInformationJobObject = libKernel32.func("SetInformationJobObject", "int", [
      "void *",
      "int",
      koffi.pointer(JOBOBJECT_EXTENDED_LIMIT_INFORMATION),
      "uint32"
    ]);
    OpenProcess = libKernel32.func("OpenProcess", "void *", ["uint32", "int", "uint32"]);
    AssignProcessToJobObject = libKernel32.func("AssignProcessToJobObject", "int", ["void *", "void *"]);
    TerminateJobObject = libKernel32.func("TerminateJobObject", "int", ["void *", "uint32"]);
    CloseHandle = libKernel32.func("CloseHandle", "int", ["void *"]);
  } catch (err) {
    console.error("[ProcessJail] Failed to initialize win32 FFI with koffi:", err);
  }
}

export class ProcessJail {
  private hJob: any = null;
  private attachedPids = new Set<number>();
  private pgid: number | null = null;
  private limitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  private memoryLimitBytes = 0;

  constructor() {
    if (process.platform === "win32" && CreateJobObjectW) {
      try {
        this.hJob = CreateJobObjectW(null, null);
        if (!this.hJob) {
          console.error("[ProcessJail] CreateJobObjectW returned null handle");
        } else {
          this.applyJobLimits();
        }
      } catch (err) {
        console.error("[ProcessJail] Error creating Windows Job Object:", err);
      }
    }
  }

  /** Set the memory limit (in bytes) for each process in the jail (Windows only). */
  public setMemoryLimit(limitBytes: number): void {
    if (limitBytes <= 0) return;
    this.memoryLimitBytes = limitBytes;
    this.limitFlags |= 0x0100; // JOB_OBJECT_LIMIT_PROCESS_MEMORY
    this.applyJobLimits();
  }

  private applyJobLimits(): void {
    if (process.platform !== "win32" || !this.hJob || !SetInformationJobObject) return;

    try {
      const info = {
        BasicLimitInformation: {
          PerProcessUserTimeLimit: 0n,
          PerJobUserTimeLimit: 0n,
          LimitFlags: this.limitFlags,
          MinimumWorkingSetSize: 0,
          MaximumWorkingSetSize: 0,
          ActiveProcessLimit: 0,
          Affinity: 0,
          PriorityClass: 0,
          SchedulingClass: 0
        },
        IoInfo: {
          ReadOperationCount: 0n,
          WriteOperationCount: 0n,
          OtherOperationCount: 0n,
          ReadTransferCount: 0n,
          WriteTransferCount: 0n,
          OtherTransferCount: 0n
        },
        ProcessMemoryLimit: this.memoryLimitBytes,
        JobMemoryLimit: 0,
        PeakProcessMemoryUsed: 0,
        PeakJobMemoryUsed: 0
      };

      const size = koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION);
      const res = SetInformationJobObject(this.hJob, 9, info, size); // 9 = JobObjectExtendedLimitInformation
      if (!res) {
        console.error("[ProcessJail] SetInformationJobObject failed");
      }
    } catch (err) {
      console.error("[ProcessJail] Error setting Job Object limits:", err);
    }
  }

  /** Attach a spawned child process PID to this jail. */
  public attachProcess(pid: number): boolean {
    if (process.platform === "win32") {
      if (!this.hJob || !OpenProcess || !AssignProcessToJobObject || !CloseHandle) {
        return false;
      }
      try {
        const PROCESS_SET_QUOTA = 0x0100;
        const PROCESS_TERMINATE = 0x0001;
        const hProcess = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if (!hProcess) {
          return false;
        }
        const res = AssignProcessToJobObject(this.hJob, hProcess);
        CloseHandle(hProcess);
        if (res) {
          this.attachedPids.add(pid);
          return true;
        }
      } catch (err) {
        console.error(`[ProcessJail] Failed to attach PID ${pid} on Windows:`, err);
      }
      return false;
    } else {
      // POSIX: store PID as the pgid (since child is spawned detached, pid === pgid)
      this.pgid = pid;
      this.attachedPids.add(pid);
      return true;
    }
  }

  /** Terminate all processes currently running in this jail. */
  public killAll(): void {
    if (process.platform === "win32") {
      if (this.hJob && TerminateJobObject) {
        try {
          TerminateJobObject(this.hJob, 1);
        } catch (err) {
          console.error("[ProcessJail] Error terminating Windows Job Object:", err);
        }
      }
    } else {
      if (this.pgid !== null) {
        try {
          // Send SIGKILL to the entire process group
          process.kill(-this.pgid, "SIGKILL");
        } catch (err: any) {
          // Ignore ESRCH (process already dead)
          if (err.code !== "ESRCH") {
            console.error(`[ProcessJail] Error killing POSIX process group -${this.pgid}:`, err);
          }
        }
      }
    }
  }

  /** Close the jail handles. */
  public dispose(): void {
    this.killAll();
    if (process.platform === "win32" && this.hJob && CloseHandle) {
      try {
        CloseHandle(this.hJob);
        this.hJob = null;
      } catch (err) {
        console.error("[ProcessJail] Error closing Windows Job Object handle:", err);
      }
    }
    this.attachedPids.clear();
    this.pgid = null;
  }
}
