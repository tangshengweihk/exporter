<script lang="ts">
  import { onMount } from 'svelte';
  import axios from 'axios';
  import Chart from 'chart.js/auto';
  import type { Chart as ChartType } from 'chart.js';

  // 设备管理
  interface Device {
    id: string;
    ip: string;
    url: string;
    name: string;
  }

  // CPU核心使用率接口
  interface CoreUsage {
    core: string;
    usage: number;
    frequency: number;
    index: number;
  }
  
  let devices: Device[] = [];
  let currentDevice: Device | null = null;
  let newDeviceIP = '';
  let newDeviceName = '';
  let cpuCoreUsages: CoreUsage[] = [];
  
  // 固定的配置
  const DEFAULT_PORT = '9182';
  const DEFAULT_METRICS_PATH = '/metrics';

  // 网络相关
  let receivedData = 0;
  let sentData = 0;
  let totalData = 0;
  let bandwidth = 0;
  let receivedPackets = 0;
  let sentPackets = 0;
  let currentReceivedBytes = 0;
  let currentSentBytes = 0;
  
  // CPU 相关
  let cpuUsage = 0;
  let cpuCores = 0;
  let cpuFreq = 0;
  let cpuIdleTimes: number[] = [];
  let cpuTotalTimes: number[] = [];
  let lastCpuIdleTimes: number[] = [];
  let lastCpuTotalTimes: number[] = [];
  
  // 内存相关
  let memoryTotal = 0;
  let memoryUsed = 0;
  let memoryFree = 0;
  
  // 磁盘相关
  let diskTotal = 0;
  let diskUsed = 0;
  let diskFree = 0;

  // 图表实例
  let networkChart: ChartType;
  let cpuChart: ChartType;
  let memoryChart: ChartType;
  let diskChart: ChartType;

  // 速率计算相关变量
  let receivedSpeed = 0;
  let sentSpeed = 0;
  let lastReceivedBytes = 0;
  let lastSentBytes = 0;
  let lastTimestamp = Date.now();

  // 添加 canvas 元素的引用
  let networkCanvas: HTMLCanvasElement;
  let cpuCanvas: HTMLCanvasElement;
  let memoryCanvas: HTMLCanvasElement;
  let diskCanvas: HTMLCanvasElement;

  // 添加错误状态变量
  let fetchError = '';
  let isLoading = false;

  // 添加重试相关变量
  let retryCount = 0;
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000; // 2秒

  // 添加轮询间隔变量
  let pollingInterval: ReturnType<typeof setInterval> | null = null;

  // 修改文件操作相关函数
  async function saveDevicesToFile() {
    try {
      const response = await axios.post('/api/devices', { devices });
      if (!response.data.success) {
        throw new Error('保存设备配置失败');
      }
    } catch (error) {
      console.error('保存设备配置失败:', error);
      throw error;
    }
  }

  async function loadDevicesFromFile() {
    try {
      const response = await axios.get('/api/devices');
      devices = response.data.devices;
      if (devices.length > 0) {
        currentDevice = devices[0];
        setTimeout(initializeCharts, 100);
        startPolling();
      }
    } catch (error) {
      console.error('加载设备配置失败:', error);
      throw error;
    }
  }

  // 修改添加设备函数
  function addDevice() {
    if (!newDeviceIP || !newDeviceName) return;
    
    const device: Device = {
      id: Date.now().toString(),
      ip: newDeviceIP,
      url: `/api/metrics`,
      name: newDeviceName
    };
    
    devices = [...devices, device];
    if (!currentDevice) {
      currentDevice = device;
      initializeCharts();
      fetchMetricsWithRetry();
      startPolling();
    }
    
    // 保存到本地存储和文件
    localStorage.setItem('monitorDevices', JSON.stringify(devices));
    saveDevicesToFile();
    
    newDeviceIP = '';
    newDeviceName = '';
  }

  // 修改移除设备函数
  function removeDevice(id: string) {
    devices = devices.filter(d => d.id !== id);
    if (currentDevice?.id === id) {
      currentDevice = devices[0] || null;
      if (!currentDevice) {
        stopPolling();
        resetAllData();
      } else {
        stopPolling();
        startPolling();
      }
    }
    // 更新本地存储和文件
    localStorage.setItem('monitorDevices', JSON.stringify(devices));
    saveDevicesToFile();
  }

  function selectDevice(device: Device) {
    currentDevice = device;
    
    // 重置错误状态
    fetchError = '';
    isLoading = false;
    
    // 销毁旧图表
    if(networkChart) {
      networkChart.destroy();
      networkChart = undefined;
    }
    if(cpuChart) {
      cpuChart.destroy();
      cpuChart = undefined;
    }
    if(memoryChart) {
      memoryChart.destroy();
      memoryChart = undefined;
    }
    if(diskChart) {
      diskChart.destroy();
      diskChart = undefined;
    }
    
    // 等待DOM更新后重新初始化图表
    setTimeout(() => {
      initializeCharts();
      startPolling();
    }, 500);
  }

  async function fetchMetrics() {
    if (!currentDevice) return;
    
    isLoading = true;
    fetchError = '';
    
    try {
      const response = await axios.get('/api/metrics', {
        headers: {
          'X-Target-URL': `http://${currentDevice.ip}:${DEFAULT_PORT}`
        },
        timeout: 10000
      });
      
      if (typeof response.data !== 'string') {
        console.error('Unexpected metrics format:', response.data);
        fetchError = '数据格式错误';
        return;
      }

      const metrics = response.data;
      const lines = metrics.split('\n');
      
      // 用于存储每个核心的时间数据
      interface CoreTimeData {
        idle: number;
        user: number;
        privileged: number;
        interrupt: number;
        dpc: number;
        total: number;
        lastTotal: number;
        lastIdle: number;
      }

      let coreTimes = new Map<string, CoreTimeData>();
      
      lines.forEach((line: string) => {
        // CPU时间统计
        if(line.includes('windows_cpu_time_total')) {
          const match = line.match(/core="([^"]+)",mode="([^"]+)"/);
          if (match) {
            const core = match[1];
            const mode = match[2] as keyof CoreTimeData;
            const value = parseFloat(line.split(' ').pop() || '0');
            
            if (!coreTimes.has(core)) {
              coreTimes.set(core, {
                idle: 0,
                user: 0,
                privileged: 0,
                interrupt: 0,
                dpc: 0,
                total: 0,
                lastTotal: 0,
                lastIdle: 0
              });
            }
            
            const coreData = coreTimes.get(core)!;
            if (mode !== 'total') {
              // 保存上一次的值
              if (mode === 'idle') {
                coreData.lastIdle = coreData.idle;
                coreData.idle = value;
              }
              coreData[mode] = value;
              
              // 计算总时间
              const newTotal = coreData.idle + coreData.user + coreData.privileged + 
                             coreData.interrupt + coreData.dpc;
              coreData.lastTotal = coreData.total;
              coreData.total = newTotal;
            }
          }
        }

        // 网络指标
        if(line.includes('windows_net_bytes_received_total')) {
          const value = parseFloat(line.split(' ').pop() || '0');
          currentReceivedBytes = value;
          receivedData = value / (1024 * 1024 * 1024); // GB
        }
        if(line.includes('windows_net_bytes_sent_total')) {
          const value = parseFloat(line.split(' ').pop() || '0');
          currentSentBytes = value;
          sentData = value / (1024 * 1024 * 1024); // GB
        }
        
        // CPU 指标
        if(line.includes('windows_cpu_processor_mperf_total{')) {
          const parts = line.split('{')[1].split('}')[0].split(',');
          const core = parts.find(p => p.includes('core='))?.split('"')[1];
          const value = parseFloat(line.split(' ').pop() || '0');
          
          if (core !== undefined) {
            const [processor, thread] = core.split(',').map(Number);
            const index = thread + processor * 2; // 每个处理器有两个线程
            
            if (!isNaN(index) && index >= 0) {
              // 初始化数组元素
              if (!cpuTotalTimes[index]) {
                cpuTotalTimes[index] = 0;
                cpuIdleTimes[index] = 0;
              }
              
              cpuTotalTimes[index] = value;
              console.log(`CPU Total - Processor ${processor}, Thread ${thread}: ${value}`);
            }
          }
        }
        
        if(line.includes('windows_cpu_processor_performance_total{')) {
          const parts = line.split('{')[1].split('}')[0].split(',');
          const core = parts.find(p => p.includes('core='))?.split('"')[1];
          const value = parseFloat(line.split(' ').pop() || '0');
          
          if (core !== undefined) {
            const [processor, thread] = core.split(',').map(Number);
            const index = thread + processor * 2;
            
            if (!isNaN(index) && index >= 0) {
              if (!cpuIdleTimes[index]) {
                cpuIdleTimes[index] = 0;
              }
              cpuIdleTimes[index] = value;
              console.log(`CPU Performance - Processor ${processor}, Thread ${thread}: ${value}`);
            }
          }
        }

        // CPU 核心数
        if(line.includes('windows_cpu_logical_processor')) {
          const value = parseInt(line.split(' ').pop() || '0');
          if (value > 0) {
            cpuCores = value;
            // 初始化 CPU 数组
            if (cpuIdleTimes.length !== value) {
              cpuIdleTimes = new Array(value).fill(0);
              cpuTotalTimes = new Array(value).fill(0);
              lastCpuIdleTimes = new Array(value).fill(0);
              lastCpuTotalTimes = new Array(value).fill(0);
            }
          }
        }

        // CPU 频率
        if(line.includes('windows_cpu_core_frequency_mhz')) {
          const value = parseFloat(line.split(' ').pop() || '0');
          if (!isNaN(value)) {
            cpuFreq = value / 1000; // 转换为 GHz
          }
        }
        
        // 内存指标
        if(line.includes('windows_os_visible_memory_bytes')) {
          const value = parseFloat(line.split(' ').pop() || '0');
          memoryTotal = value / (1024 * 1024 * 1024); // GB
        }
        if(line.includes('windows_memory_available_bytes')) {
          const value = parseFloat(line.split(' ').pop() || '0');
          memoryFree = value / (1024 * 1024 * 1024); // GB
          memoryUsed = Math.max(0, memoryTotal - memoryFree);
        }
        
        // 磁盘指标
        if(line.includes('windows_logical_disk_size_bytes{volume="C:"}')) {
          const value = parseFloat(line.split(' ').pop() || '0');
          diskTotal = value / (1024 * 1024 * 1024); // GB
        }
        if(line.includes('windows_logical_disk_free_bytes{volume="C:"}')) {
          const value = parseFloat(line.split(' ').pop() || '0');
          diskFree = value / (1024 * 1024 * 1024); // GB
          diskUsed = Math.max(0, diskTotal - diskFree);
        }
      });

      // 计算每个核心的使用率
      cpuCoreUsages = Array.from(coreTimes.entries())
        .map(([core, data]) => {
          // 计算非空闲时间（用户态 + 系统态 + 中断 + DPC）
          const nonIdleTime = data.user + data.privileged + data.interrupt + data.dpc;
          // 计算总时间
          const totalTime = nonIdleTime + data.idle;
          // 计算使用率
          const usage = totalTime > 0 ? (nonIdleTime / totalTime) * 100 : 0;
          
          return {
            core,
            usage,
            frequency: cpuFreq,
            index: core.split(',').map(Number).reduce((p: number, c: number, i: number) => i === 0 ? p + c * 2 : p + c, 0)
          };
        })
        .sort((a, b) => a.index - b.index);

      // 计算总CPU使用率（使用所有核心的平均值）
      cpuUsage = cpuCoreUsages.reduce((sum, core) => sum + core.usage, 0) / cpuCoreUsages.length;
      console.log('CPU Usage:', cpuUsage.toFixed(2) + '%');

      // 计算网络速率
      const currentTimestamp = Date.now();
      const timeDiff = (currentTimestamp - lastTimestamp) / 1000;
      
      if (lastReceivedBytes > 0 && lastSentBytes > 0) {
        // 转换为 Mb/s (1 MB = 8 Mb)
        receivedSpeed = ((currentReceivedBytes - lastReceivedBytes) / timeDiff) / (1024 * 1024) * 8;
        sentSpeed = ((currentSentBytes - lastSentBytes) / timeDiff) / (1024 * 1024) * 8;
      }

      lastReceivedBytes = currentReceivedBytes;
      lastSentBytes = currentSentBytes;
      lastTimestamp = currentTimestamp;

      // 更新图表
      updateCharts();

    } catch (error: unknown) {
      console.error('获取指标数据失败:', error);
      
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          fetchError = `连接超时: 无法连接到 ${currentDevice.ip}:${DEFAULT_PORT}`;
        } else if (error.response) {
          fetchError = `服务器错误: ${error.response.status}`;
        } else if (error.request) {
          fetchError = `网络错误: 请检查设备是否在线`;
        } else {
          fetchError = `未知错误: ${error.message}`;
        }
      } else {
        fetchError = `未知错误: ${error instanceof Error ? error.message : '发生未知错误'}`;
      }
      
      // 重置所有数据为0
      receivedSpeed = 0;
      sentSpeed = 0;
      memoryUsed = 0;
      memoryTotal = 0;
      diskUsed = 0;
      diskTotal = 0;
      
      updateCharts();
    } finally {
      isLoading = false;
    }
  }

  function updateCharts() {
    if(networkCanvas && networkChart) {
      networkChart.data.datasets[0].data = [receivedSpeed, sentSpeed];
      networkChart.update('none');
    }
    
    if(cpuCanvas && cpuChart) {
      cpuChart.data.datasets[0].data = [cpuUsage, 100 - cpuUsage];
      if (cpuChart.options?.plugins?.title) {
        cpuChart.options.plugins.title.text = `CPU 使用率 (${cpuCores}核)`;
      }
      cpuChart.update('none');
    }
    
    if(memoryCanvas && memoryChart) {
      memoryChart.data.datasets[0].data = [memoryUsed, memoryFree];
      memoryChart.update('none');
    }

    if(diskCanvas && diskChart) {
      diskChart.data.datasets[0].data = [diskUsed, diskFree];
      diskChart.update('none');
    }
  }

  function initializeCharts() {
    if (!networkCanvas || !cpuCanvas || !memoryCanvas || !diskCanvas) {
      console.log('Canvas elements not ready');
      return;
    }

    try {
      if (!networkChart) {
        networkChart = new Chart(networkCanvas, {
          type: 'bar',
          data: {
            labels: ['下载速度', '上传速度'],
            datasets: [{
              label: '实时网络速度',
              data: [0, 0],
              backgroundColor: [
                'rgba(54, 162, 235, 0.5)',
                'rgba(255, 99, 132, 0.5)'
              ],
              borderColor: [
                'rgba(54, 162, 235, 1)',
                'rgba(255, 99, 132, 1)'
              ],
              borderWidth: 1
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: false
              },
              tooltip: {
                callbacks: {
                  label: function(tooltipItem: any) {
                    const value = tooltipItem.raw as number;
                    return `${value.toFixed(2)} Mb/s`;
                  }
                }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                title: {
                  display: true,
                  text: 'Mb/s'
                }
              }
            },
            animation: {
              duration: 0
            }
          }
        });
      }

      if (!cpuChart) {
        cpuChart = new Chart(cpuCanvas, {
          type: 'doughnut',
          data: {
            labels: ['已用', '空闲'],
            datasets: [{
              data: [0, 100],
              backgroundColor: [
                'rgba(255, 159, 64, 0.5)',
                'rgba(54, 162, 235, 0.5)'
              ],
              borderColor: [
                'rgba(255, 159, 64, 1)',
                'rgba(54, 162, 235, 1)'
              ],
              borderWidth: 1
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              title: {
                display: true,
                text: 'CPU 使用率'
              },
              legend: {
                position: 'bottom'
              }
            },
            animation: {
              duration: 0
            }
          }
        });
      }

      if (!memoryChart) {
        memoryChart = new Chart(memoryCanvas, {
          type: 'pie',
          data: {
            labels: ['已用内存', '可用内存'],
            datasets: [{
              data: [0, 0],
              backgroundColor: [
                'rgba(255, 99, 132, 0.5)',
                'rgba(75, 192, 192, 0.5)'
              ],
              borderColor: [
                'rgba(255, 99, 132, 1)',
                'rgba(75, 192, 192, 1)'
              ],
              borderWidth: 1
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              title: {
                display: true,
                text: '内存使用情况'
              },
              legend: {
                position: 'bottom'
              }
            },
            animation: {
              duration: 0
            }
          }
        });
      }

      if (!diskChart) {
        diskChart = new Chart(diskCanvas, {
          type: 'pie',
          data: {
            labels: ['已用空间', '可用空间'],
            datasets: [{
              data: [0, 0],
              backgroundColor: [
                'rgba(253, 121, 168, 0.5)',
                'rgba(178, 190, 195, 0.5)'
              ],
              borderColor: [
                'rgba(253, 121, 168, 1)',
                'rgba(178, 190, 195, 1)'
              ],
              borderWidth: 1
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              title: {
                display: true,
                text: '磁盘使用情况'
              },
              legend: {
                position: 'bottom'
              }
            },
            animation: {
              duration: 0
            }
          }
        });
      }
    } catch (error) {
      console.error('初始化图表失败:', error);
    }
  }

  async function fetchMetricsWithRetry() {
    retryCount = 0;
    await tryFetchMetrics();
  }

  async function tryFetchMetrics() {
    if (!currentDevice) return;
    
    try {
      await fetchMetrics();
      retryCount = 0; // 成功后重置重试计数
    } catch (error) {
      console.error(`尝试 ${retryCount + 1}/${MAX_RETRIES} 失败:`, error);
      
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        setTimeout(tryFetchMetrics, RETRY_DELAY);
      }
    }
  }

  // 修改轮询控制函数
  async function startPolling() {
    if (!pollingInterval) {
      // 立即执行一次数据获取
      await fetchMetricsWithRetry();
      // 然后开始定期轮询
      pollingInterval = setInterval(fetchMetricsWithRetry, 2000);
    }
  }

  function stopPolling() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  // 添加重置数据的函数
  function resetAllData() {
    // 网络相关
    receivedData = 0;
    sentData = 0;
    totalData = 0;
    bandwidth = 0;
    receivedPackets = 0;
    sentPackets = 0;
    currentReceivedBytes = 0;
    currentSentBytes = 0;
    receivedSpeed = 0;
    sentSpeed = 0;
    lastReceivedBytes = 0;
    lastSentBytes = 0;
    lastTimestamp = Date.now();
    
    // 内存相关
    memoryTotal = 0;
    memoryUsed = 0;
    memoryFree = 0;
    
    // 磁盘相关
    diskTotal = 0;
    diskUsed = 0;
    diskFree = 0;

    // 更新图表
    updateCharts();
  }

  // 修改 onMount
  onMount(() => {
    loadDevicesFromFile().then(() => {
      // 等待一段时间确保DOM元素已经渲染
      setTimeout(() => {
        if (currentDevice) {
          initializeCharts();
          startPolling();
        }
      }, 500);
    }).catch(error => {
      console.error('加载设备配置失败:', error);
    });
    
    return () => {
      stopPolling();
      if(networkChart) networkChart.destroy();
      if(cpuChart) cpuChart.destroy();
      if(memoryChart) memoryChart.destroy();
      if(diskChart) diskChart.destroy();
    };
  });
</script>

<div class="dashboard">
  <header>
    <h1>系统资源监控</h1>
    <div class="device-manager">
      <div class="device-list">
        {#each devices as device}
          <div class="device-item" class:active={currentDevice?.id === device.id}>
            <button class="device-select" on:click={() => selectDevice(device)}>
              {device.name} ({device.ip})
            </button>
            <button class="device-remove" on:click={() => removeDevice(device.id)}>×</button>
          </div>
        {/each}
      </div>
      <div class="device-add">
        <input 
          type="text" 
          bind:value={newDeviceName}
          placeholder="设备名称"
        />
        <input 
          type="text" 
          bind:value={newDeviceIP}
          placeholder="IP地址"
        />
        <button on:click={addDevice}>添加设备</button>
      </div>
    </div>
  </header>

  {#if currentDevice}
    {#if fetchError}
      <div class="error-message">
        <p>{fetchError}</p>
      </div>
    {/if}
    <div class="metrics-grid">
      <section class="metric-section network">
        <h2>网络状态</h2>
        <div class="section-content">
          <div class="cards-container">
            <div class="metric-card">
              <h3>实时速度</h3>
              <p class="value">↓ {receivedSpeed.toFixed(2)} Mb/s</p>
              <p class="value">↑ {sentSpeed.toFixed(2)} Mb/s</p>
            </div>
            <div class="metric-card">
              <h3>总流量</h3>
              <p class="value">{totalData.toFixed(2)} GB</p>
            </div>
            <div class="metric-card">
              <h3>数据包</h3>
              <p class="value">↓ {receivedPackets.toLocaleString()}</p>
              <p class="value">↑ {sentPackets.toLocaleString()}</p>
            </div>
          </div>
          <div class="chart-container">
            <canvas bind:this={networkCanvas}></canvas>
          </div>
        </div>
      </section>

      <section class="metric-section memory">
        <h2>内存状态</h2>
        <div class="section-content">
          <div class="cards-container">
            <div class="metric-card">
              <h3>总内存</h3>
              <p class="value">{memoryTotal.toFixed(1)} GB</p>
            </div>
            <div class="metric-card">
              <h3>已用内存</h3>
              <p class="value">{memoryUsed.toFixed(1)} GB</p>
            </div>
            <div class="metric-card">
              <h3>可用内存</h3>
              <p class="value">{memoryFree.toFixed(1)} GB</p>
            </div>
          </div>
          <div class="chart-container">
            <canvas bind:this={memoryCanvas}></canvas>
          </div>
        </div>
      </section>

      <section class="metric-section cpu">
        <h2>CPU 状态</h2>
        <div class="section-content">
          <div class="cards-container">
            <div class="metric-card">
              <h3>使用率</h3>
              <p class="value">{cpuUsage.toFixed(1)}%</p>
            </div>
            <div class="metric-card">
              <h3>频率</h3>
              <p class="value">{cpuFreq > 0 ? `${cpuFreq.toFixed(2)} GHz` : '不可用'}</p>
            </div>
            <div class="metric-card">
              <h3>核心数</h3>
              <p class="value">{cpuCores}</p>
            </div>
          </div>
          <div class="chart-container">
            <canvas bind:this={cpuCanvas}></canvas>
          </div>
        </div>
      </section>

      <section class="metric-section disk">
        <h2>磁盘状态</h2>
        <div class="section-content">
          <div class="cards-container">
            <div class="metric-card">
              <h3>总容量</h3>
              <p class="value">{diskTotal.toFixed(1)} GB</p>
            </div>
            <div class="metric-card">
              <h3>已用空间</h3>
              <p class="value">{diskUsed.toFixed(1)} GB</p>
            </div>
            <div class="metric-card">
              <h3>可用空间</h3>
              <p class="value">{diskFree.toFixed(1)} GB</p>
            </div>
          </div>
          <div class="chart-container">
            <canvas bind:this={diskCanvas}></canvas>
          </div>
        </div>
      </section>
    </div>

    <div class="cpu-details">
      <h2>CPU 详细数据</h2>
      <div class="cpu-data-grid">
        {#each cpuCoreUsages as coreData}
          {@const [processor, thread] = coreData.core.split(',').map(Number)}
          <div class="cpu-data-item">
            <h3>处理器 {processor}, 线程 {thread}</h3>
            <div class="usage-bar" style="--usage: {coreData.usage}%">
              <div class="usage-fill"></div>
            </div>
            <p>使用率: {coreData.usage.toFixed(1)}%</p>
            <p>频率: {coreData.frequency.toFixed(2)} GHz</p>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <div class="no-device">
      <p>请添加要监控的设备</p>
    </div>
  {/if}
</div>

<style>
  .dashboard {
    min-height: 100vh;
    background: #f5f6fa;
    padding: 1rem;
  }

  header {
    margin-bottom: 1rem;
  }

  h1 {
    text-align: center;
    color: #2d3436;
    font-size: 1.75rem;
    margin: 0 0 1rem 0;
  }

  .device-manager {
    background: white;
    padding: 1rem;
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    margin-bottom: 1rem;
  }

  .device-list {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }

  .device-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .device-select {
    padding: 0.5rem 1rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    background: #f8f9fa;
    cursor: pointer;
  }

  .device-select:hover {
    background: #e9ecef;
  }

  .device-item.active .device-select {
    background: #339af0;
    color: white;
    border-color: #339af0;
  }

  .device-remove {
    padding: 0.5rem;
    border: none;
    background: #ff6b6b;
    color: white;
    border-radius: 4px;
    cursor: pointer;
  }

  .device-add {
    display: flex;
    gap: 0.5rem;
  }

  .device-add input {
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    flex: 1;
  }

  .device-add button {
    padding: 0.5rem 1rem;
    background: #339af0;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
    margin: 0 auto;
    max-width: 1800px;
  }

  .metric-section {
    background: white;
    border-radius: 8px;
    padding: 1rem;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    height: 500px;
    display: flex;
    flex-direction: column;
  }

  .section-content {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  h2 {
    color: #2d3436;
    font-size: 1.25rem;
    margin: 0 0 0.75rem 0;
  }

  .cards-container {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    flex-shrink: 0;
  }

  .metric-card {
    background: #f8f9fa;
    padding: 0.75rem;
    border-radius: 6px;
    text-align: center;
  }

  .metric-card h3 {
    color: #636e72;
    font-size: 0.875rem;
    margin: 0 0 0.25rem 0;
  }

  .value {
    font-size: 1rem;
    font-weight: bold;
    margin: 0.25rem 0;
  }

  .chart-container {
    background: #f8f9fa;
    padding: 0.75rem;
    border-radius: 6px;
    height: 300px;
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .no-device {
    text-align: center;
    padding: 2rem;
    background: white;
    border-radius: 8px;
    margin-top: 1rem;
  }

  .network .value { color: #0984e3; }
  .cpu .value { color: #00b894; }
  .memory .value { color: #6c5ce7; }
  .disk .value { color: #fd79a8; }

  .error-message {
    background: #fff3f3;
    border: 1px solid #ff6b6b;
    color: #e03131;
    padding: 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    text-align: center;
  }

  .error-message p {
    margin: 0;
  }

  @media (max-width: 1200px) {
    .metrics-grid {
      grid-template-columns: 1fr;
    }
    
    .metric-section {
      height: 450px;
    }
    
    .chart-container {
      height: 250px;
    }
  }

  .cpu-details {
    background: white;
    border-radius: 8px;
    padding: 1rem;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    margin-top: 1rem;
    max-width: 1800px;
    margin-left: auto;
    margin-right: auto;
  }

  .cpu-data-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1rem;
    margin-top: 1rem;
  }

  .cpu-data-item {
    background: #f8f9fa;
    padding: 1rem;
    border-radius: 6px;
    position: relative;
    overflow: hidden;
  }

  .usage-bar {
    width: 100%;
    height: 4px;
    background: #e9ecef;
    margin: 0.5rem 0;
    border-radius: 2px;
    overflow: hidden;
  }

  .usage-fill {
    height: 100%;
    width: var(--usage);
    background: linear-gradient(90deg, #4cd137, #e84118);
    transition: width 0.3s ease;
  }

  .cpu-data-item h3 {
    color: #2d3436;
    font-size: 1rem;
    margin: 0 0 0.5rem 0;
  }

  .cpu-data-item p {
    margin: 0.25rem 0;
    color: #636e72;
    font-size: 0.875rem;
  }
</style>

