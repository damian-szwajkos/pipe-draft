// What the simulator knows about Jenkins: sections, directives, conditions, steps.

export const PIPELINE_SECTIONS = ['agent', 'environment', 'libraries', 'options', 'parameters', 'post', 'stages', 'tools', 'triggers'];
export const STAGE_SECTIONS = ['agent', 'environment', 'failFast', 'input', 'matrix', 'options', 'parallel', 'post', 'stages', 'steps', 'tools', 'when'];
export const AGENT_TYPES = ['any', 'docker', 'dockerfile', 'kubernetes', 'label', 'node', 'none'];
export const WHEN_CONDITIONS = ['allOf', 'anyOf', 'branch', 'buildingTag', 'changeRequest', 'changelog', 'changeset',
  'environment', 'equals', 'expression', 'isRestartedRun', 'not', 'tag', 'triggeredBy'];
export const WHEN_FLAGS = ['beforeAgent', 'beforeInput', 'beforeOptions'];
// Order in which Jenkins evaluates post conditions.
export const POST_CONDITIONS = ['always', 'changed', 'fixed', 'regression', 'aborted', 'failure', 'success',
  'unstable', 'unsuccessful', 'notBuilt', 'cleanup'];
export const PARAMETER_TYPES = ['booleanParam', 'choice', 'credentials', 'file', 'password', 'run', 'string', 'text'];
export const TRIGGER_TYPES = ['cron', 'pollSCM', 'upstream', 'githubPush', 'gitlab', 'GenericTrigger', 'issueCommentTrigger'];
export const OPTIONS = ['buildDiscarder', 'checkoutToSubdirectory', 'disableConcurrentBuilds', 'disableResume',
  'durabilityHint', 'newContainerPerStage', 'overrideIndexTriggers', 'parallelsAlwaysFailFast', 'preserveStashes',
  'quietPeriod', 'rateLimitBuilds', 'retry', 'skipDefaultCheckout', 'skipStagesAfterUnstable', 'timeout',
  'timestamps', 'ansiColor', 'lock', 'copyArtifactPermission', 'githubProjectProperty', 'gitLabConnection', 'withAWS',
  'withCredentials', 'disableRestartFromStage'];

// Steps the simulator implements (or knows to be harmless).
export const KNOWN_STEPS = new Set([
  'echo', 'println', 'print', 'sh', 'bat', 'powershell', 'pwsh', 'git', 'checkout', 'scm', 'deleteDir', 'cleanWs',
  'dir', 'withEnv', 'withCredentials', 'credentials', 'string', 'usernamePassword', 'usernameColonPassword', 'file',
  'sshUserPrivateKey', 'certificate', 'timeout', 'retry', 'sleep', 'error', 'unstable', 'catchError', 'warnError',
  'script', 'stash', 'unstash', 'archiveArtifacts', 'archive', 'junit', 'publishHTML', 'recordIssues', 'jacoco',
  'input', 'milestone', 'lock', 'writeFile', 'readFile', 'fileExists', 'readJSON', 'writeJSON', 'readYaml',
  'writeYaml', 'readProperties', 'readMavenPom', 'httpRequest', 'slackSend', 'mail', 'emailext', 'build', 'node',
  'stage', 'parallel', 'withDockerRegistry', 'withDockerContainer', 'withKubeConfig', 'sshagent', 'withMaven',
  'withAWS', 'withSonarQubeEnv', 'waitForQualityGate', 'ansiColor', 'timestamps', 'wrap', 'container', 'podTemplate',
  'ws', 'tool', 'isUnix', 'pwd', 'properties', 'pipelineTriggers', 'parameters', 'booleanParam', 'choice', 'text',
  'password', 'cron', 'pollSCM', 'upstream', 'buildDiscarder', 'logRotator', 'disableConcurrentBuilds',
  'currentBuild', 'library', 'load', 'addBadge', 'addShortText', 'setGitHubPullRequestStatus', 'githubNotify',
  'step', 'cobertura', 'publishChecks', 'nexusArtifactUploader', 'kubernetesDeploy', 'withGradle', 'zip', 'unzip',
  'findFiles', 'touch', 'sha1', 'tee', 'office365ConnectorSend', 'notifyBitbucket', 'gitlabCommitStatus',
  'updateGitlabCommitStatus', 'checkout', 'validateDeclarativePipeline', 'getContext', 'pipeline',
]);

// Steps that need a workspace (an agent / node) to run.
export const NEEDS_NODE = new Set(['sh', 'bat', 'powershell', 'pwsh', 'checkout', 'git', 'deleteDir', 'cleanWs',
  'dir', 'stash', 'unstash', 'archiveArtifacts', 'archive', 'junit', 'writeFile', 'readFile', 'fileExists',
  'readJSON', 'writeJSON', 'readYaml', 'writeYaml', 'readProperties', 'readMavenPom', 'publishHTML', 'recordIssues',
  'jacoco', 'withMaven', 'findFiles', 'zip', 'unzip', 'touch', 'pwd', 'tool']);

// Groovy-level statements a declarative `steps` block may not contain directly.
export const NOT_A_STEP = new Set(['VarDecl', 'MultiDecl', 'If', 'ForIn', 'ForC', 'While', 'Try', 'Switch',
  'Return', 'Throw', 'Break', 'Continue', 'Block']);
