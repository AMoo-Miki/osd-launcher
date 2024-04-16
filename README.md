# OSD Launcher

CLI to ease the setup of OpenSearch and Dashboards

### Installation
`npm i -g osd-launcher`

### Quick Start
`osd-launcher -os 2.13.0 -osd 2.13.0 -d /usr/share -p P@$5w04t`

### Usage

```
Usage: osd-launcher [options]

Options:
  -os, --opensearch-version <version>          OpenSearch version to use
  -osd, --dashboards-version <version|repo>    Dashboards version to use
                                               <version>: use a released version
                                               <repo>: clone from a repository
  -d, --destination <path>                     Location for deploying 
                                               (default: current working directory)
  --no-plugins                                 Prevent installation of Dashboards plugins
  --no-security                                Disable the Security plugins in OpenSearch and
                                               Dashboards
  --refresh-downloads                          Re-download artifacts even if they are
                                               available in cache
  --opensearch-host <hostname|IP>              Hostname or IP address for OpenSearch to
                                               listen on (default: "127.0.0.1")
  --opensearch-port <number>                   Port number for OpenSearch to listen on
                                               (default: "9200")
  --dashboards-host <hostname|IP>              Hostname or IP address for OpenSearch to
                                               listen on (default: "0.0.0.0")
  --dashboards-port <number>                   Port number for OpenSearch to listen on
                                               (default: "5601")
  -u, --username <username>                    Username to use if security is enable
                                               (default: "admin")
  -p, --password <password>                    Password to use if security is enable
  -dev --no-build                              Skip building Dashboards when cloned
  -v, --version                                Print launcher version
  -h, --help                                   display help for command

Fine-tuning Dashboards plugins:
  The version of Dashboards plugins can be specified using --<name>-source <repo>.
  The inclusion of a plugin can be prevented using --no-<name>.
  
  Supported plugin names are: 
    alerting                Alerting
    anomaly-detection       Anomaly Detection
    assistant               Assistant
    index-management        Index Management
    maps                    Maps
    ml-commons              ML Commons
    notifications           Notifications
    observability           Observability
    query-workbench         Query Workbench
    reporting               Reports
    search-relevance        Search Relevance
    security-analytics      Security Analytics
    security                Security
    gantt-chart             Visualizations
  
  If a specific release version of Dashboards is requested, the plugins included with the
  release will be installed and the fine-tuned source parameters have no effect.
   
  Installing Dashboards from a GitHub source, if no plugin-specific source is requested, the
  plugins will be cloned from the official sources.
  
<version> format:
  A complete release version includes all 3 components of a semantic version. e.g. 2.15.0
  
<repo> format:
  A GitHub source starts with "github:" and includes all 3 names of the use, the repository
  and the branch:
    github:opensearch-project/opensearch-dashboards/awesome-feature
    
  A shorthand alternative is also supported to use a branch from the official repositories:
    github://2.x
    
  If Dashboards is cloned from a numeric branch name (e.g. 2.15 and 2.x), the plugins will
  be cloned from the matching branch of the official sources, unless a specific source is
  requested for them. 
```