# Обращение к DEV(разработческому) серверу postgres на d2(w2)
psql -h 192.168.1.12 -U carl -d carlinkng

# На команду вида: "Перейди в проекты" нужно выдать: 
cd C:\ERV\projects-ex

# На команду вида: "Смержи main с dev" нужно выдать:
git checkout main \ 
git merge dev \ 
git checkout dev 

# На команду вида: юникод или utf или utf8 или 65001 выдать:                                
chcp 65001