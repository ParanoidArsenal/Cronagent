pipeline {
    options {
        gitLabConnection("gitlab")
        buildDiscarder(logRotator(numToKeepStr: '10', artifactNumToKeepStr: '10'))
        disableConcurrentBuilds()
        timeout(time: 30, unit: 'MINUTES')
        timestamps()
    }

    agent {
        label 'build-agent'
    }

    stages {
        stage('Build & Push') {
            steps {
                updateGitlabCommitStatus name: "build", state: "running"

                sh '''
                    chmod +x build.sh
                    ./build.sh
                '''
            }
        }

        stage('Deploy') {
            steps {
                sh '''
                    cd /opt/automation-repl && \
                    sudo docker compose pull && \
                    sudo docker compose up -d
                '''
            }
        }
    }

    post {
        failure {
            updateGitlabCommitStatus name: "build", state: "failed"
        }
        success {
            updateGitlabCommitStatus name: "build", state: "success"
        }
        unstable {
            updateGitlabCommitStatus name: "build", state: "failed"
        }
    }
}
